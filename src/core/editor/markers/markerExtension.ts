/**
 * Renders transcript time markers (see markerParser) as a small speaker icon,
 * and defends them against editing.
 *
 * The markers are ordinary characters in the document rather than positions
 * held alongside it. That is what makes them survive: deleting a range of text
 * cannot disturb a token outside the range, order and identity are preserved
 * because the tokens *are* the document, and undo, dirty state and files
 * edited elsewhere all work without any special handling.
 *
 * What in-band markers do need is protection from edits that land *inside* a
 * token, which is what `atomicRanges` and the change filter below provide.
 */

import {
  EditorState,
  Extension,
  Range,
  StateEffect,
  StateField,
  Transaction
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { changeSplits, Marker, parseMarkers } from "./markerParser";

/** Shows or hides the marker icons. Dispatched by the menu/keyboard toggle. */
export const setMarkersVisibleEffect = StateEffect.define<boolean>();

/**
 * The decoration applied to a marker token.
 *
 * A `mark`, not a `replace`. Replacing was the obvious choice — the token is
 * machinery the reader should not see — but CodeMirror wraps every replaced
 * range in `<img class="cm-widgetBuffer">` elements, and an image inside the
 * editable is half of what crashes WebKitGTK 2.52.3's accessibility layer; the
 * en dash inside the token is the other half. A mark leaves the text in the
 * document and hides it in CSS, so no image is emitted.
 *
 * See dev_notes/webkit-replace-freeze-progress.md. The AT_SPI_BUS_ADDRESS
 * workaround in src-tauri/src/lib.rs now covers this bug wherever it appears,
 * including formatExtension's replace decorations, so the choice here could be
 * revisited — but a mark costs nothing and needs no environment variable.
 *
 * The times ride along as data attributes so that a click on the icon can be
 * answered without re-reading the document, and so the tracked set carries
 * everything a caller needs.
 */
const markerDecoration = (marker: Marker): Decoration =>
  Decoration.mark({
    class: "cm-marker",
    attributes: {
      title: `${marker.start.toFixed(2)}–${marker.end.toFixed(2)}s`,
      // The token is machinery, so it is hidden from assistive technology as
      // well as from the eye. It stays in the document either way: removing it
      // from the rendering is what replacing did, and what crashed the browser.
      "aria-hidden": "true",
      "data-marker-start": String(marker.start),
      "data-marker-end": String(marker.end)
    }
  });

/**
 * The lines an edit touched, in the new document, as whole-line ranges.
 *
 * Whole lines rather than the exact edited range because a marker cannot span a
 * line break — the token is digits, a dot and a dash — so any marker the edit
 * created, destroyed or altered lies entirely within one of these ranges. That
 * is what makes patching only these ranges sufficient.
 */
const touchedLineRanges = (tr: Transaction): { from: number; to: number }[] => {
  const doc = tr.state.doc;
  const ranges: { from: number; to: number }[] = [];

  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    const from = doc.lineAt(fromB).from;
    const to = doc.lineAt(toB).to;
    const previous = ranges[ranges.length - 1];
    // Changes arrive in document order, so overlapping or adjacent ranges can
    // be merged as we go and each line is only ever scanned once.
    if (previous && from <= previous.to) {
      previous.to = Math.max(previous.to, to);
    } else {
      ranges.push({ from, to });
    }
  });

  return ranges;
};

const decorationsFor = (text: string, offset: number): Range<Decoration>[] =>
  parseMarkers(text, offset).map((marker) =>
    markerDecoration(marker).range(marker.from, marker.to)
  );

/**
 * The markers, held as a RangeSet rather than an array.
 *
 * The data structure is the whole point. A RangeSet is a persistent B-tree, so
 * mapping it through an edit reuses every subtree the edit did not touch, and
 * `between` finds the markers overlapping a span without walking the rest. An
 * array would force every consumer — decorations, atomic ranges, the change
 * filter — to touch all markers on every keystroke, which is work proportional
 * to the document rather than to what the user just did.
 *
 * Kept up to date in two steps:
 *
 *   - `map` moves everything the edit did not touch, in time proportional to
 *     the size of the change rather than the number of markers;
 *   - each touched line is then replaced wholesale: its old markers are
 *     filtered out and the line is read afresh. Mapping can move what it
 *     already knows about, but only a rescan finds a marker that has just been
 *     pasted, or completed by typing its last character.
 */
const markerField = StateField.define<DecorationSet>({
  create: (state) => Decoration.set(decorationsFor(state.doc.toString(), 0), true),

  update(markers, tr) {
    if (!tr.docChanged) {
      return markers;
    }
    let updated = markers.map(tr.changes);
    for (const range of touchedLineRanges(tr)) {
      updated = updated.update({
        filterFrom: range.from,
        filterTo: range.to,
        filter: () => false,
        add: decorationsFor(tr.state.doc.sliceString(range.from, range.to), range.from),
        sort: true
      });
    }
    return updated;
  },

  provide: (field) => [
    // Both facets read the field directly. Neither rebuilds anything, which is
    // what keeps a keystroke's cost independent of the document's length.
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field))
  ]
});

const createVisibilityField = (getInitialVisible: () => boolean) =>
  StateField.define<boolean>({
    create: getInitialVisible,
    update(visible, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setMarkersVisibleEffect)) {
          return effect.value;
        }
      }
      return visible;
    },
    // Visibility is a class on the editor, not a property of each decoration.
    // Hiding markers is then one string changing rather than every marker being
    // rebuilt, and the icons collapse to nothing in CSS — so the caret and
    // deletion behaviour atomicRanges provides is identical either way.
    provide: (field) =>
      EditorView.contentAttributes.compute([field], (state) =>
        state.field(field) ? { class: "" } : { class: "cm-markers-hidden" }
      )
  });

/**
 * Rejects any change that would leave a fragment of a marker behind.
 *
 * `atomicRanges` already stops the caret entering a token, which covers typing
 * and backspace. This covers everything that does not go through the caret:
 * paste, find-and-replace, select-all-and-retype, and programmatic edits. The
 * transaction is rejected whole rather than repaired, because a partial repair
 * would silently change what the user asked for.
 *
 * Only the markers overlapping each change are examined — `between` walks that
 * span, not the document.
 */
const createChangeFilter = () =>
  EditorState.changeFilter.of((tr) => {
    if (!tr.docChanged) {
      return true;
    }
    const markers = tr.startState.field(markerField, false);
    if (!markers) {
      return true;
    }
    let damages = false;
    tr.changes.iterChanges((fromA, toA) => {
      if (damages) {
        return;
      }
      markers.between(fromA, toA, (from, to) => {
        if (changeSplits({ from, to }, fromA, toA)) {
          damages = true;
          return false;
        }
        return undefined;
      });
    });
    return !damages;
  });

/** Every marker in the document. Walks them all, so not for the hot path. */
export const markersIn = (state: EditorState): Marker[] => {
  const markers: Marker[] = [];
  const set = state.field(markerField, false);
  if (!set) {
    return markers;
  }
  const cursor = set.iter();
  while (cursor.value) {
    const attributes = (cursor.value.spec as { attributes?: Record<string, string> }).attributes;
    if (attributes) {
      markers.push({
        from: cursor.from,
        to: cursor.to,
        start: Number(attributes["data-marker-start"]),
        end: Number(attributes["data-marker-end"])
      });
    }
    cursor.next();
  }
  return markers;
};

/** The speaker glyph, as a mask so it takes its colour from the theme. */
const ICON_MASK =
  'url(\'data:image/svg+xml;utf8,' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<path d="M8 2.2 4.6 5H2.4A1.4 1.4 0 0 0 1 6.4v3.2A1.4 1.4 0 0 0 2.4 11h2.2L8 13.8Z"/>' +
  '<path d="M10.9 4.6a.7.7 0 0 0-.9 1 3.3 3.3 0 0 1 0 4.8.7.7 0 0 0 .9 1 4.7 4.7 0 0 0 0-6.8Z"/>' +
  "</svg>')";

const markerTheme = EditorView.baseTheme({
  /**
   * The token's own characters are still here; they are clipped away by a fixed
   * width and made transparent, and the icon is painted over the box as a mask
   * so it takes its colour from the theme.
   */
  ".cm-marker": {
    display: "inline-block",
    width: "0.75em",
    height: "0.75em",
    overflow: "hidden",
    color: "transparent",
    verticalAlign: "baseline",
    lineHeight: "1",
    backgroundColor: "currentColor",
    maskImage: ICON_MASK,
    WebkitMaskImage: ICON_MASK,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
    // Flush against the following word in the document, so the icon supplies
    // its own breathing room rather than the file carrying whitespace.
    marginRight: "0.25em",
    cursor: "pointer",
    opacity: "0.75"
  },
  ".cm-marker:hover": {
    opacity: "1"
  },
  /** Hidden means no icon and no text: the token takes up nothing at all. */
  ".cm-markers-hidden .cm-marker": {
    width: "0",
    marginRight: "0",
    maskImage: "none",
    WebkitMaskImage: "none",
    backgroundColor: "transparent"
  },
  "&light .cm-marker": {
    color: "transparent",
    backgroundColor: "#2563eb"
  },
  "&dark .cm-marker": {
    color: "transparent",
    backgroundColor: "#93c5fd"
  },
  "&light .cm-markers-hidden .cm-marker, &dark .cm-markers-hidden .cm-marker": {
    backgroundColor: "transparent"
  }
});

export type MarkersExtension = {
  markerField: StateField<DecorationSet>;
  visibilityField: StateField<boolean>;
  extension: Extension;
};

export const createMarkers = (getInitialVisible: () => boolean): MarkersExtension => {
  const visibilityField = createVisibilityField(getInitialVisible);

  return {
    markerField,
    visibilityField,
    extension: [markerField, visibilityField, createChangeFilter(), markerTheme]
  };
};
