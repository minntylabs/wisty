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
  RangeSet,
  StateEffect,
  StateField
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { Marker, parseMarkers, splitsMarker } from "./markerParser";

/** Shows or hides the marker icons. Dispatched by the menu/keyboard toggle. */
export const setMarkersVisibleEffect = StateEffect.define<boolean>();

/**
 * A speaker icon standing in for the token. Inline SVG rather than a text
 * glyph so it stays crisp at any zoom and takes its colour from the theme.
 */
class MarkerIconWidget extends WidgetType {
  constructor(private readonly marker: Marker) {
    super();
  }

  /**
   * Widgets are recreated on every decoration rebuild; telling CodeMirror when
   * two are equivalent lets it keep the existing DOM node instead of replacing
   * it, which matters because a replaced node loses any in-flight interaction.
   */
  eq(other: MarkerIconWidget): boolean {
    return other.marker.start === this.marker.start && other.marker.end === this.marker.end;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-marker-icon";
    // Both times, for a tooltip: the icon deliberately shows nothing itself.
    wrapper.title = `${this.marker.start.toFixed(2)}–${this.marker.end.toFixed(2)}s`;
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.innerHTML =
      '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" focusable="false">' +
      '<path d="M8 2.2 4.6 5H2.4A1.4 1.4 0 0 0 1 6.4v3.2A1.4 1.4 0 0 0 2.4 11h2.2L8 13.8Z"/>' +
      '<path d="M10.9 4.6a.7.7 0 0 0-.9 1 3.3 3.3 0 0 1 0 4.8.7.7 0 0 0 .9 1 4.7 4.7 0 0 0 0-6.8Z"/>' +
      "</svg>";
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

/** Markers in the current document, recomputed whenever the text changes. */
const markerField = StateField.define<Marker[]>({
  create: (state) => parseMarkers(state.doc.toString()),
  update: (markers, tr) => (tr.docChanged ? parseMarkers(tr.state.doc.toString()) : markers)
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
    }
  });

/**
 * Both states replace the token: shown swaps in the icon, hidden collapses it
 * to nothing. Only the widget differs, so the caret and deletion behaviour
 * that `atomicRanges` provides is identical either way — a marker is never
 * partially present.
 */
const buildDecorations = (markers: readonly Marker[], visible: boolean): DecorationSet => {
  const ranges: Range<Decoration>[] = markers.map((marker) =>
    (visible
      ? Decoration.replace({ widget: new MarkerIconWidget(marker) })
      : Decoration.replace({})
    ).range(marker.from, marker.to)
  );
  return Decoration.set(ranges, true);
};

const markerRanges = (markers: readonly Marker[]): RangeSet<Decoration> =>
  RangeSet.of(
    markers.map((marker) => Decoration.replace({}).range(marker.from, marker.to)),
    true
  );

/**
 * Rejects any change that would leave a fragment of a marker behind.
 *
 * `atomicRanges` already stops the caret entering a token, which covers typing
 * and backspace. This covers everything that does not go through the caret:
 * paste, find-and-replace, select-all-and-retype, and programmatic edits. The
 * transaction is rejected whole rather than repaired, because a partial repair
 * would silently change what the user asked for.
 */
const createChangeFilter = () =>
  EditorState.changeFilter.of((tr) => {
    if (!tr.docChanged) {
      return true;
    }
    const markers = tr.startState.field(markerField, false);
    if (!markers || markers.length === 0) {
      return true;
    }
    let damages = false;
    tr.changes.iterChanges((fromA, toA) => {
      if (splitsMarker(markers, fromA, toA)) {
        damages = true;
      }
    });
    return !damages;
  });

const markerTheme = EditorView.baseTheme({
  ".cm-marker-icon": {
    display: "inline-block",
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
  "&light .cm-marker-icon": {
    color: "#2563eb"
  },
  "&dark .cm-marker-icon": {
    color: "#93c5fd"
  }
});

export type MarkersExtension = {
  markerField: StateField<Marker[]>;
  visibilityField: StateField<boolean>;
  extension: Extension;
};

export const createMarkers = (getInitialVisible: () => boolean): MarkersExtension => {
  const visibilityField = createVisibilityField(getInitialVisible);

  return {
    markerField,
    visibilityField,
    extension: [
      markerField,
      visibilityField,
      EditorView.decorations.compute([markerField, visibilityField], (state) =>
        buildDecorations(state.field(markerField), state.field(visibilityField))
      ),
      // Stepping over a marker rather than into it, so the caret can never sit
      // inside "734.12" and produce a token that still parses but points
      // somewhere wrong.
      EditorView.atomicRanges.of((view) => markerRanges(view.state.field(markerField))),
      createChangeFilter(),
      markerTheme
    ]
  };
};
