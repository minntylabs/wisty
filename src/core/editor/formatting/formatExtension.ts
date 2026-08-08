import {
  Annotation,
  ChangeSpec,
  EditorSelection,
  EditorState,
  Extension,
  Range,
  StateEffect,
  StateField,
  Transaction
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { FormatViewMode } from "../../settings/settingsTypes";

/** Switches the live view mode. Dispatched by the menu/keyboard toggle. */
export const setFormatModeEffect = StateEffect.define<FormatViewMode>();

/**
 * Marks a transaction as a deliberate formatting edit (wrap/unwrap, heading
 * change). Such edits may remove marker characters, but that removal is the
 * user's intent — not a stray delete — so the reveal-on-delete rule ignores it
 * and formatted view is preserved.
 */
const formattingEdit = Annotation.define<boolean>();

/** Matches an ATX heading prefix ("## ") at the start of a line. */
const HEADING_PATTERN = /^(#{1,6})[ \t]+/;

/**
 * Longest run of content characters an emphasis span may contain. The toggle
 * commands always produce single-line spans, so this only matters for
 * documents authored elsewhere; it bounds how far past the viewport the
 * decorator must scan and keeps a stray unpaired delimiter from bleeding
 * styling across the whole document.
 */
const EMPHASIS_MAX_LENGTH = 1000;

/**
 * Longest possible whole match in UTF-16 code units. The `u`-flag quantifier
 * caps content at EMPHASIS_MAX_LENGTH code *points*, each of which can occupy
 * two code units (emoji and other astral characters), plus a pair of
 * 2-character `**` delimiters — and CodeMirror positions are code units.
 */
const MAX_MATCH_LENGTH = 2 * EMPHASIS_MAX_LENGTH + 4;

/**
 * Inline emphasis, delimiters kept out of the captured content. Bold is tried
 * before italic so `**x**` is not read as two stray `*`. The parser applies
 * only the outermost style: nested delimiters remain visible literal text.
 * Bold content may
 * cross line breaks — even blank lines — up to EMPHASIS_MAX_LENGTH
 * characters; italic is confined to a single line, because stray single `*`
 * and `_` characters are common in ordinary text (wildcards, snake_case) and
 * letting them pair across lines would mis-style everything between. Content
 * may not start or end with whitespace (CommonMark's flanking rule), which
 * keeps `* bullet` / `* lists` from reading as italic, and is one-or-more
 * non-delimiter characters, so empty runs like `****` never match — which is
 * what keeps deleting the last letter of a word from leaving orphaned markers.
 * Underscore italic additionally requires word boundaries so `snake_case` is
 * left alone.
 */
const INLINE_PATTERN = new RegExp(
  [
    String.raw`(?<!\*)\*\*(?!\s)([\s\S]{1,${EMPHASIS_MAX_LENGTH}}?)(?<!\s)\*\*(?!\*)`,
    String.raw`(?<!\*)\*(?![\s*])((?:[^*\n]|\*{2}){1,${EMPHASIS_MAX_LENGTH}}?)(?<!\s)\*(?!\*)`,
    String.raw`(?<![\p{L}\p{N}_])_(?!\s)([^_\n]{1,${EMPHASIS_MAX_LENGTH}}?)(?<!\s)_(?![\p{L}\p{N}_])`
  ].join("|"),
  "gu"
);

const boldMark = Decoration.mark({ class: "cm-fmt-bold" });
const italicMark = Decoration.mark({ class: "cm-fmt-italic" });
const hiddenMarker = Decoration.replace({});
const headingLine = (level: number) => Decoration.line({ class: `cm-fmt-h${level}` });

/** True when the transaction removes any document content (delete, cut, replace). */
const removesContent = (tr: Transaction): boolean => {
  let removed = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (toA > fromA) {
      removed = true;
    }
  });
  return removed;
};

const createModeField = (getInitialMode: () => FormatViewMode) =>
  StateField.define<FormatViewMode>({
    create: () => getInitialMode(),
    update(mode, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setFormatModeEffect)) {
          return effect.value;
        }
      }
      // Deliberate formatting edits keep the current view even when they remove
      // marker characters, since the removal is intended rather than a stray delete.
      if (tr.annotation(formattingEdit)) {
        return mode;
      }
      // Any edit that removes content reveals the raw markup: drop to plain view
      // so the user is never deleting against invisible delimiter characters.
      if (mode === "formatted" && tr.docChanged && removesContent(tr)) {
        return "plain";
      }
      return mode;
    }
  });

const collectInline = (text: string, offset: number, ranges: Range<Decoration>[]) => {
  INLINE_PATTERN.lastIndex = 0;
  for (let match = INLINE_PATTERN.exec(text); match; match = INLINE_PATTERN.exec(text)) {
    const [bold, italicStar, italicUnderscore] = [match[1], match[2], match[3]];
    const content = bold ?? italicStar ?? italicUnderscore;
    const delimiter = bold !== undefined ? 2 : 1;
    const mark = bold !== undefined ? boldMark : italicMark;

    const openFrom = offset + match.index;
    const contentFrom = openFrom + delimiter;
    const contentTo = contentFrom + content.length;
    const closeTo = contentTo + delimiter;

    ranges.push(hiddenMarker.range(openFrom, contentFrom));
    ranges.push(mark.range(contentFrom, contentTo));
    ranges.push(hiddenMarker.range(contentTo, closeTo));
  }
};

/** Builds the styling/marker-hiding decorations for the visible lines. */
const buildDecorations = (view: EditorView): DecorationSet => {
  const ranges: Range<Decoration>[] = [];
  const { doc } = view.state;

  // Inline emphasis may span line breaks, so each visible range is padded by
  // the longest possible match (a span whose other delimiter sits just outside
  // the viewport is still found whole) and snapped to whole lines (the scan
  // never starts halfway through a `**` delimiter). Padded blocks from
  // adjacent visible ranges can overlap; they are merged so nothing is
  // scanned — and decorated — twice.
  const blocks: { from: number; to: number }[] = [];

  for (const { from, to } of view.visibleRanges) {
    const blockFrom = doc.lineAt(Math.max(0, from - MAX_MATCH_LENGTH)).from;
    const blockTo = doc.lineAt(Math.min(doc.length, to + MAX_MATCH_LENGTH)).to;
    const previous = blocks[blocks.length - 1];
    if (previous && blockFrom <= previous.to) {
      previous.to = Math.max(previous.to, blockTo);
    } else {
      blocks.push({ from: blockFrom, to: blockTo });
    }

    const firstLine = doc.lineAt(from).number;
    const lastLine = doc.lineAt(to).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
      const line = doc.line(lineNumber);
      const heading = HEADING_PATTERN.exec(line.text);
      if (heading) {
        ranges.push(headingLine(heading[1].length).range(line.from));
        ranges.push(hiddenMarker.range(line.from, line.from + heading[0].length));
      }
    }
  }

  for (const block of blocks) {
    collectInline(doc.sliceString(block.from, block.to), block.from, ranges);
  }

  return Decoration.set(ranges, true);
};

const createDecorationPlugin = (modeField: StateField<FormatViewMode>) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.compute(view);
      }

      update(update: ViewUpdate) {
        const modeChanged = update.startState.field(modeField) !== update.state.field(modeField);
        if (update.docChanged || update.viewportChanged || modeChanged) {
          this.decorations = this.compute(update.view);
        }
      }

      private compute(view: EditorView): DecorationSet {
        return view.state.field(modeField) === "formatted" ? buildDecorations(view) : Decoration.none;
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );

const formatTheme = EditorView.baseTheme({
  ".cm-fmt-bold": { fontWeight: "700" },
  ".cm-fmt-italic": { fontStyle: "italic" },
  ".cm-fmt-h1": { fontSize: "1.9em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-fmt-h2": { fontSize: "1.6em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-fmt-h3": { fontSize: "1.35em", fontWeight: "700", lineHeight: "1.35" },
  ".cm-fmt-h4": { fontSize: "1.2em", fontWeight: "700" },
  ".cm-fmt-h5": { fontSize: "1.1em", fontWeight: "700" },
  ".cm-fmt-h6": { fontSize: "1em", fontWeight: "700", opacity: "0.85" }
});

/** Length of a leading ATX heading prefix on a line, 0 when there is none. */
const headingPrefix = (lineText: string): { level: number; length: number } => {
  const match = HEADING_PATTERN.exec(lineText);
  return match ? { level: match[1].length, length: match[0].length } : { level: 0, length: 0 };
};

type LineSegment = { from: number; to: number };

const isInsideOtherMarker = (state: EditorState, segment: LineSegment, marker: string): boolean => {
  const otherMarker = marker === "*" ? "**" : "*";
  const { from, to } = segment;
  const doc = state.doc.toString();
  const before = doc.slice(0, from).split(otherMarker).length - 1;
  const after = doc.slice(to).split(otherMarker).length - 1;
  return before % 2 === 1 && after % 2 === 1;
};

/**
 * The per-line pieces of [from, to], each trimmed to its non-whitespace
 * extent; blank lines contribute nothing. These are the units the inline
 * toggles wrap, so a multi-line selection gets one marker pair per line and
 * the stored markup stays line-local.
 */
const lineSegments = (state: EditorState, from: number, to: number): LineSegment[] => {
  const segments: LineSegment[] = [];
  const firstLine = state.doc.lineAt(from).number;
  const lastLine = state.doc.lineAt(to).number;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const sliceFrom = Math.max(from, line.from);
    const sliceTo = Math.min(to, line.to);
    const text = state.sliceDoc(sliceFrom, sliceTo);
    const segFrom = sliceFrom + (text.length - text.trimStart().length);
    const segTo = sliceTo - (text.length - text.trimEnd().length);
    if (segFrom < segTo) {
      segments.push({ from: segFrom, to: segTo });
    }
  }
  return segments;
};

/**
 * How a segment is already wrapped in `marker`: with the delimiters just
 * inside the segment (`**abc**` fully selected), just outside it (`abc`
 * selected within `**abc**`), or not at all. An empty segment (a bare cursor)
 * can only be wrapped "outside" — sitting between an empty marker pair.
 */
const existingWrap = (
  state: EditorState,
  segment: LineSegment,
  marker: string
): "inside" | "outside" | null => {
  const width = marker.length;
  const { from, to } = segment;
  const docLength = state.doc.length;

  const markerAt = (pos: number) =>
    pos >= 0 && pos + width <= docLength && state.sliceDoc(pos, pos + width) === marker;

  // A candidate single-`*` pair is rejected when either star is really half of
  // a `**` bold delimiter — a neighbouring `*` that is not the pair's own
  // other marker — so toggling italic never peels a layer off bold text.
  const peelsBold = (openFrom: number, closeFrom: number): boolean => {
    if (width !== 1) {
      return false;
    }
    const starAt = (pos: number) =>
      pos >= 0 && pos < docLength && state.sliceDoc(pos, pos + 1) === "*";
    return (
      starAt(openFrom - 1)
      || (starAt(openFrom + 1) && openFrom + 1 !== closeFrom)
      || starAt(closeFrom + 1)
      || (starAt(closeFrom - 1) && closeFrom - 1 !== openFrom)
    );
  };

  const wrappedBy = (openFrom: number, closeFrom: number): boolean =>
    markerAt(openFrom) && markerAt(closeFrom) && !peelsBold(openFrom, closeFrom);

  if (to - from > 2 * width && wrappedBy(from, to - width)) {
    return "inside";
  }
  if (wrappedBy(from - width, to)) {
    return "outside";
  }
  return null;
};

/**
 * Toggles `marker` around the selection, line by line: every non-blank line
 * gets its own marker pair, trimmed to its non-whitespace extent. When every
 * line is already wrapped the command unwraps them all; on a mixed selection
 * it wraps just the unwrapped lines, so repeating the shortcut round-trips.
 * With an empty selection it inserts an empty marker pair and drops the
 * cursor between the delimiters, ready to type — and if the cursor already
 * sits between such a pair, it removes it instead, so that gesture
 * round-trips too.
 */
const toggleInlineWrap = (view: EditorView, marker: string): boolean => {
  const { state } = view;
  const width = marker.length;

  const spec = state.changeByRange((range) => {
    if (range.empty) {
      if (existingWrap(state, range, marker) === "outside") {
        return {
          changes: [
            { from: range.from - width, to: range.from },
            { from: range.to, to: range.to + width }
          ],
          range: EditorSelection.cursor(range.from - width)
        };
      }
      return {
        changes: { from: range.from, insert: marker + marker },
        range: EditorSelection.cursor(range.from + width)
      };
    }

    const segments = lineSegments(state, range.from, range.to);
    // This editor deliberately supports a small, non-nesting formatting
    // grammar. Do not turn a shortcut inside the other style into ambiguous
    // `***` markup that formatted view would have to partially interpret.
    if (segments.some((segment) => isInsideOtherMarker(state, segment, marker))) {
      return { range };
    }
    const wraps = segments.map((segment) => existingWrap(state, segment, marker));
    const changes: ChangeSpec[] = [];

    if (segments.length > 0 && wraps.every((wrap) => wrap !== null)) {
      segments.forEach(({ from, to }, index) => {
        if (wraps[index] === "inside") {
          changes.push({ from, to: from + width }, { from: to - width, to });
        } else {
          changes.push({ from: from - width, to: from }, { from: to, to: to + width });
        }
      });
    } else {
      segments.forEach(({ from, to }, index) => {
        if (wraps[index] === null) {
          changes.push({ from, insert: marker }, { from: to, insert: marker });
        }
      });
    }

    if (changes.length === 0) {
      return { range };
    }

    const changeSet = state.changes(changes);
    const first = segments[0];
    const last = segments[segments.length - 1];
    return {
      changes: changeSet,
      // The original range can include whitespace that was deliberately left
      // outside the markers. Keep the selection over the actual formatted
      // content so repeating the command sees the pair it just created.
      range: EditorSelection.range(changeSet.mapPos(first.from, 1), changeSet.mapPos(last.to, -1))
    };
  });

  view.dispatch(view.state.update(spec, { annotations: formattingEdit.of(true), userEvent: "input" }));
  view.focus();
  return true;
};

export const toggleBold = (view: EditorView): boolean => toggleInlineWrap(view, "**");
export const toggleItalic = (view: EditorView): boolean => toggleInlineWrap(view, "*");

/**
 * Sets every line touched by the selection to heading `level` (1–6), or clears
 * the heading when `level` is 0. Re-applying a line's existing level clears it,
 * so the same shortcut toggles a heading off.
 */
export const setHeadingLevel = (view: EditorView, level: number): boolean => {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seenLines = new Set<number>();

  for (const range of state.selection.ranges) {
    const firstLine = state.doc.lineAt(range.from).number;
    const lastLine = state.doc.lineAt(range.to).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
      if (seenLines.has(lineNumber)) {
        continue;
      }
      seenLines.add(lineNumber);

      const line = state.doc.line(lineNumber);
      const existing = headingPrefix(line.text);
      const targetLevel = level > 0 && existing.level === level ? 0 : level;
      const insert = targetLevel > 0 ? `${"#".repeat(targetLevel)} ` : "";
      if (existing.length === 0 && insert === "") {
        continue;
      }
      changes.push({ from: line.from, to: line.from + existing.length, insert });
    }
  }

  if (changes.length === 0) {
    return false;
  }

  // Map the selection forward through the edit so a cursor at the line start
  // lands after the inserted prefix (ready to type) rather than before it.
  const changeSet = state.changes(changes);
  view.dispatch(
    state.update({
      changes: changeSet,
      selection: state.selection.map(changeSet, 1),
      annotations: formattingEdit.of(true),
      userEvent: "input"
    })
  );
  view.focus();
  return true;
};

export type FormattingExtension = {
  modeField: StateField<FormatViewMode>;
  extension: Extension;
};

/**
 * Builds the formatting feature: a live view-mode field (with the reveal-on-delete
 * rule), the decoration plugin that hides markers and styles content in formatted
 * mode, and the theme. `getInitialMode` is read whenever a fresh editor state is
 * created so new/reset documents open in the persisted mode.
 */
export const createFormatting = (getInitialMode: () => FormatViewMode): FormattingExtension => {
  const modeField = createModeField(getInitialMode);
  return {
    modeField,
    extension: [modeField, createDecorationPlugin(modeField), formatTheme]
  };
};
