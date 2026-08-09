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
  Prec,
  Range,
  StateEffect,
  StateField,
  Transaction
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";
import { changeSplits, Marker, parseMarkers } from "../../tsf/markers";

/** Shows or hides the marker icons. Dispatched by the menu/keyboard toggle. */
export const setMarkersVisibleEffect = StateEffect.define<boolean>();

/** Told the times of the marker that was clicked. See createMarkers. */
export type MarkerClickHandler = (start: number, end: number) => void;

/**
 * A speaker icon standing in for the token. Inline SVG rather than a text
 * glyph so it stays crisp at any zoom and takes its colour from the theme.
 */
class MarkerIconWidget extends WidgetType {
  readonly start: number;
  readonly end: number;
  private readonly onClick: MarkerClickHandler;

  constructor(marker: Marker, onClick: MarkerClickHandler) {
    super();
    this.start = marker.start;
    this.end = marker.end;
    this.onClick = onClick;
  }

  /**
   * Widgets are recreated on every decoration rebuild; telling CodeMirror when
   * two are equivalent lets it keep the existing DOM node instead of replacing
   * it, which matters because a replaced node loses any in-flight interaction.
   */
  eq(other: MarkerIconWidget): boolean {
    return other.start === this.start && other.end === this.end;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("button");
    wrapper.type = "button";
    wrapper.className = "cm-marker-icon";
    const label = `Play audio from ${this.start.toFixed(2)} to ${this.end.toFixed(2)} seconds`;
    // Both times are available to sighted and assistive-technology users.
    wrapper.title = `${this.start.toFixed(2)}–${this.end.toFixed(2)}s`;
    wrapper.setAttribute("aria-label", label);
    wrapper.innerHTML =
      '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" focusable="false">' +
      '<path d="M8 2.2 4.6 5H2.4A1.4 1.4 0 0 0 1 6.4v3.2A1.4 1.4 0 0 0 2.4 11h2.2L8 13.8Z"/>' +
      '<path d="M10.9 4.6a.7.7 0 0 0-.9 1 3.3 3.3 0 0 1 0 4.8.7.7 0 0 0 .9 1 4.7 4.7 0 0 0 0-6.8Z"/>' +
      "</svg>";
    // On the element rather than delegated from the editor, because
    // ignoreEvent below stops these reaching the editor at all. Claim mousedown
    // so a mouse activation never starts a text selection; click also covers
    // the browser's Enter/Space activation for the semantic button.
    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
    });
    wrapper.addEventListener("click", (event) => {
      event.preventDefault();
      this.onClick(this.start, this.end);
    });
    return wrapper;
  }

  /**
   * True so events inside the widget are left to the widget rather than being
   * treated as editor interaction. Playback hangs a click handler here later;
   * without this the click would place the caret instead.
   */
  ignoreEvent(): boolean {
    return true;
  }
}


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

const decorationsFor = (
  text: string,
  offset: number,
  onClick: MarkerClickHandler
): Range<Decoration>[] =>
  parseMarkers(text, offset).map((marker) =>
    Decoration.replace({ widget: new MarkerIconWidget(marker, onClick) }).range(
      marker.from,
      marker.to
    )
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
const createMarkerField = (onClick: MarkerClickHandler) =>
  StateField.define<DecorationSet>({
    create: (state) => Decoration.set(decorationsFor(state.doc.toString(), 0, onClick), true),

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
        add: decorationsFor(
          tr.state.doc.sliceString(range.from, range.to),
          range.from,
          onClick
        ),
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

/** Whether this one change would leave a fragment of a marker behind. */
const changeDamagesMarker = (
  markers: DecorationSet,
  fromA: number,
  toA: number
): boolean => {
  let damages = false;
  // Only the markers overlapping the change are examined: `between` walks that
  // span, not the document.
  markers.between(fromA, toA, (from, to) => {
    if (changeSplits({ from, to }, fromA, toA)) {
      damages = true;
      return false;
    }
    return undefined;
  });
  return damages;
};

/**
 * Drops any change that would leave a fragment of a marker behind, and lets the
 * rest of its transaction through.
 *
 * `atomicRanges` already stops the caret entering a token, which covers typing
 * and backspace. This covers everything that does not go through the caret:
 * paste, find-and-replace, select-all-and-retype, and programmatic edits.
 *
 * A `changeFilter` returning false was the obvious way to write this, and it is
 * wrong for the case that matters: it cancels the whole transaction. Replace All
 * arrives as one transaction holding every replacement, and a marker's token is
 * still in the document under its icon — `⟦734.12–736.80⟧` — so searching for
 * `12` or `.` matches inside one. A single such match threw away every other
 * replacement in the document, silently.
 *
 * So the damaging changes are removed and the transaction is rebuilt from what
 * is left. The user gets the edit they asked for everywhere it was safe, and
 * the markers they did not ask to edit stay whole.
 */
const createChangeFilter = (markerField: StateField<DecorationSet>) =>
  EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) {
      return tr;
    }
    const markers = tr.startState.field(markerField, false);
    if (!markers) {
      return tr;
    }

    const kept: { from: number; to: number; insert: string }[] = [];
    let dropped = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (changeDamagesMarker(markers, fromA, toA)) {
        dropped = true;
        return;
      }
      kept.push({ from: fromA, to: toA, insert: inserted.toString() });
    });

    if (!dropped) {
      return tr;
    }
    if (kept.length === 0) {
      // Nothing survived, so there is no edit to make. The selection is left
      // alone deliberately: the caret has not moved and neither has the text.
      return [];
    }
    return {
      changes: kept,
      // Positions in `tr` are for a document this transaction no longer
      // produces, so the selection and the scroll intent cannot be carried
      // over. What survives is the edit itself.
      annotations: Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? "input")
    };
  });

/** Every marker in the document. Walks them all, so not for the hot path. */
const markersInField = (state: EditorState, markerField: StateField<DecorationSet>): Marker[] => {
  const markers: Marker[] = [];
  const set = state.field(markerField, false);
  if (!set) {
    return markers;
  }
  const cursor = set.iter();
  while (cursor.value) {
    const widget = (cursor.value.spec as { widget?: MarkerIconWidget }).widget;
    if (widget) {
      markers.push({ from: cursor.from, to: cursor.to, start: widget.start, end: widget.end });
    }
    cursor.next();
  }
  return markers;
};

const markerTheme = EditorView.baseTheme({
  ".cm-marker-icon": {
    display: "inline-block",
    padding: "0",
    border: "0",
    background: "none",
    verticalAlign: "baseline",
    lineHeight: "1",
    // Flush against the following word in the document, so the icon supplies
    // its own breathing room rather than the file carrying whitespace.
    marginRight: "0.25em",
    cursor: "pointer",
    opacity: "0.75"
  },
  ".cm-marker-icon:hover": {
    opacity: "1"
  },
  ".cm-marker-icon:focus-visible": {
    outline: "2px solid currentColor",
    outlineOffset: "2px"
  },
  ".cm-markers-hidden .cm-marker-icon": {
    display: "none"
  },
  "&light .cm-marker-icon": {
    color: "#2563eb"
  },
  "&dark .cm-marker-icon": {
    color: "#93c5fd"
  }
});

/**
 * Keyboard playback, and the reason it is a caret command rather than focus
 * moving between icons.
 *
 * F5 works whether or not the icons are shown. Hiding markers is about reading
 * the transcript without the clutter, not about giving up playback — and
 * someone who presses F5 with the icons hidden has asked for a sentence
 * plainly enough. What hiding removes is the mouse path, because there is
 * nothing left to click.
 *
 * The icons are semantic buttons for pointer and assistive-technology users.
 * F5 remains the efficient editor-native path: while tidying, the caret is
 * already in the sentence in question.
 *
 * The marker introducing that sentence is the last one at or before the caret
 * on its line. Falling back to the line's first marker covers the caret sitting
 * in the speaker label, where "play this turn" is the only sensible reading.
 * Confined to the line because a turn is a line: without that, a caret before
 * the first marker would play the previous speaker's last sentence.
 */
const playbackKeymap = (
  markerField: StateField<DecorationSet>,
  onMarkerClick: MarkerClickHandler,
  onStop: () => void
) => [
  keymap.of([
    {
      key: "F5",
      // Every path returns true, including the ones that play nothing: F5 is
      // this editor's key and there is no other meaning to fall through to.
      run: (view) => {
        const markers = view.state.field(markerField, false);
        if (!markers) {
          return true;
        }
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        let chosen: MarkerIconWidget | undefined;
        markers.between(line.from, line.to, (from, _to, value) => {
          const widget = (value.spec as { widget?: MarkerIconWidget }).widget;
          // Ascending, so the last one starting at or before the caret wins;
          // the first marker on the line is whatever was seen first.
          if (widget && (from <= pos || chosen === undefined)) {
            chosen = widget;
          }
          return undefined;
        });
        if (!chosen) {
          return true;
        }
        onMarkerClick(chosen.start, chosen.end);
        return true;
      }
    }
  ]),
  // Highest precedence so it runs before tidy mode's Escape, and returns false
  // so it consumes nothing: pressing Escape silences the audio AND still
  // clears a tidy-mode selection, rather than taking two presses to do both.
  Prec.highest(
    keymap.of([
      {
        key: "Escape",
        run: () => {
          onStop();
          return false;
        }
      }
    ])
  )
];

export type MarkersExtension = {
  markerField: StateField<DecorationSet>;
  /** Every marker in the document. Walks them all, so not for the hot path. */
  markersIn: (state: EditorState) => Marker[];
  visibilityField: StateField<boolean>;
  extension: Extension;
};

export type MarkersOptions = {
  getInitialVisible: () => boolean;
  /** A marker's icon was clicked, or F5 was pressed inside its sentence. */
  onMarkerClick: MarkerClickHandler;
  /** Escape was pressed. Silences whatever is playing. */
  onStop: () => void;
};

export const createMarkers = ({
  getInitialVisible,
  onMarkerClick,
  onStop
}: MarkersOptions): MarkersExtension => {
  const visibilityField = createVisibilityField(getInitialVisible);
  // The field is built per instance rather than shared at module scope so the
  // click handler can be closed over. Injecting it is what keeps this module
  // free of any dependency on audio: it never learns what a click does.
  const markerField = createMarkerField(onMarkerClick);

  return {
    markerField,
    visibilityField,
    markersIn: (state) => markersInField(state, markerField),
    extension: [
      markerField,
      visibilityField,
      createChangeFilter(markerField),
      playbackKeymap(markerField, onMarkerClick, onStop),
      markerTheme
    ]
  };
};
