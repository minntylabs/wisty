/**
 * Transcript mode: hover a word to select it, wheel to extend the selection one
 * word at a time, click to reattribute it to another speaker.
 *
 * The whole feature lives behind this extension, which the adapter installs and
 * removes wholesale via a compartment — so none of these handlers exist while
 * the mode is off. That matters because the clicks are destructive and would
 * otherwise fire on an ordinary caret-repositioning click.
 *
 * The document surgery itself is in transcriptMoves.ts; this module is the
 * CodeMirror layer over it: anchor state, pointer handling, decorations.
 */

import { isolateHistory } from "@codemirror/commands";
import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  Transaction
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  keymap
} from "@codemirror/view";
import {
  type Turn,
  expandToNeighbouringTurns,
  turnAt,
  wordIndexAt,
  wordSpans
} from "./transcriptParser";
import {
  type DocChange,
  type WordOutcome,
  buildLabelMerge,
  buildTurnDelete,
  buildWordMove,
  canMergeIntoPrevious,
  classifyWordSelection,
  detectTurnGap,
  normalizeTurnGaps
} from "./transcriptMoves";

/**
 * The hovered word plus a signed word offset, or a hovered label. Positions are
 * absolute and only ever valid against the document they were taken from, which
 * is why any document change clears the anchor.
 */
type Anchor =
  | { kind: "word"; wordFrom: number; wordTo: number; offset: number }
  | { kind: "label"; from: number; to: number };

const setAnchor = StateEffect.define<Anchor | null>();
/** Marks the transient selection that follows the pointer in transcript mode. */
export const transcriptHoverSelection = Annotation.define<boolean>();

const anchorsEqual = (a: Anchor | null, b: Anchor | null): boolean => {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.kind === "word" && b.kind === "word") {
    return a.wordFrom === b.wordFrom && a.wordTo === b.wordTo && a.offset === b.offset;
  }
  if (a.kind === "label" && b.kind === "label") {
    return a.from === b.from && a.to === b.to;
  }
  return false;
};

const anchorField = StateField.define<Anchor | null>({
  create: () => null,
  update(anchor, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAnchor)) {
        return effect.value;
      }
    }
    // Anchors are transient pointer state, not document structure. Rather than
    // map them through edits, drop them: the next mouse move re-establishes one.
    return tr.docChanged ? null : anchor;
  }
});

/** The label's extent excluding its trailing gap, so the highlight ends at the colon. */
const labelRange = (state: EditorState, turn: Turn): { from: number; to: number } => {
  const raw = state.doc.sliceString(turn.from, turn.textFrom);
  return { from: turn.from, to: turn.textFrom - (raw.length - raw.trimEnd().length) };
};

type Resolved =
  | { kind: "word"; turn: Turn; from: number; to: number; outcome: WordOutcome }
  | { kind: "label"; turn: Turn; from: number; to: number; canMerge: boolean };

/**
 * Turns an anchor back into a concrete selection and the outcome a click on it
 * would have. Returns null when the anchor no longer describes a real word,
 * which the callers treat as "do nothing".
 */
const resolve = (state: EditorState, anchor: Anchor | null): Resolved | null => {
  if (!anchor) {
    return null;
  }

  const turn = turnAt(state.doc, anchor.kind === "word" ? anchor.wordFrom : anchor.from);
  if (!turn) {
    return null;
  }

  if (anchor.kind === "label") {
    const { from, to } = labelRange(state, turn);
    return { kind: "label", turn, from, to, canMerge: canMergeIntoPrevious(state.doc, turn) };
  }

  const spans = wordSpans(turn);
  const anchorIndex = spans.findIndex(
    (span) => span.from === anchor.wordFrom && span.to === anchor.wordTo
  );
  if (anchorIndex === -1) {
    return null;
  }

  const targetIndex = Math.max(0, Math.min(spans.length - 1, anchorIndex + anchor.offset));
  const from = spans[Math.min(anchorIndex, targetIndex)].from;
  const to = spans[Math.max(anchorIndex, targetIndex)].to;
  return { kind: "word", turn, from, to, outcome: classifyWordSelection(state.doc, turn, from, to) };
};

/** How far the offset may run before it would leave the turn. */
const offsetBounds = (state: EditorState, anchor: Anchor): { min: number; max: number } | null => {
  if (anchor.kind !== "word") {
    return null;
  }
  const turn = turnAt(state.doc, anchor.wordFrom);
  if (!turn) {
    return null;
  }
  const spans = wordSpans(turn);
  const anchorIndex = spans.findIndex(
    (span) => span.from === anchor.wordFrom && span.to === anchor.wordTo
  );
  if (anchorIndex === -1) {
    return null;
  }
  return { min: -anchorIndex, max: spans.length - 1 - anchorIndex };
};

const HINT_TEXT: Record<WordOutcome, string> = {
  toPrevious: "↑",
  toNext: "↓",
  split: "⋔",
  none: ""
};

class HintWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: HintWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-transcript-hint";
    span.textContent = this.text;
    return span;
  }
}

/**
 * Marks the selection with the outcome a click would have. The same-looking
 * selection is destructive in two directions, creates turns, or is inert, so
 * the tint and glyph are the only thing telling the user which before they
 * commit — the split in particular fragments the transcript on a stray click.
 */
const buildDecorations = (state: EditorState): DecorationSet => {
  const resolved = resolve(state, state.field(anchorField));
  if (!resolved || resolved.from >= resolved.to) {
    return Decoration.none;
  }

  if (resolved.kind === "label") {
    return Decoration.set([
      Decoration.mark({ class: "cm-transcript-sel cm-transcript-label" })
        .range(resolved.from, resolved.to),
      Decoration.widget({
        widget: new HintWidget(resolved.canMerge ? "↑ ✕" : "✕"),
        side: 1
      }).range(resolved.to)
    ]);
  }

  const ranges = [
    Decoration.mark({ class: `cm-transcript-sel cm-transcript-${resolved.outcome}` })
      .range(resolved.from, resolved.to)
  ];
  const hint = HINT_TEXT[resolved.outcome];
  if (hint) {
    ranges.push(Decoration.widget({ widget: new HintWidget(hint), side: 1 }).range(resolved.to));
  }
  return Decoration.set(ranges, true);
};

/** Pixels of wheel travel per word. Tuned for a notched mouse; trackpads accumulate. */
const WHEEL_STEP_PIXELS = 50;
const LINE_HEIGHT_PIXELS = 20;
const PAGE_HEIGHT_PIXELS = 400;

/**
 * Wheel events are not notches: a trackpad or free-spinning wheel emits a stream
 * of small deltas, and one flick can be twenty events. Travel is accumulated and
 * spent a word at a time so extension is precise rather than wild.
 */
const createWheelAccumulator = () => {
  let travel = 0;
  let anchorKey = "";

  return (event: WheelEvent, currentAnchorKey: string): number => {
    if (currentAnchorKey !== anchorKey) {
      anchorKey = currentAnchorKey;
      travel = 0;
    }

    const scale = event.deltaMode === 1
      ? LINE_HEIGHT_PIXELS
      : event.deltaMode === 2
        ? PAGE_HEIGHT_PIXELS
        : 1;
    const delta = event.deltaY * scale;

    // Reversing direction spends the pending travel immediately, so scrolling
    // back the other way responds on the first notch rather than after a lag.
    if (travel !== 0 && Math.sign(delta) !== Math.sign(travel)) {
      travel = 0;
    }

    travel += delta;
    const steps = Math.trunc(travel / WHEEL_STEP_PIXELS);
    travel -= steps * WHEEL_STEP_PIXELS;
    return steps;
  };
};

/**
 * The document position under the pointer, or null when the pointer is not over
 * text. posAtCoords clamps to the nearest position, so without these guards
 * hovering the empty space right of a short line would select its last word.
 */
const positionUnderPointer = (view: EditorView, event: MouseEvent): number | null => {
  const contentRect = view.contentDOM.getBoundingClientRect();
  if (
    event.clientX < contentRect.left
    || event.clientY < contentRect.top
    || event.clientY > contentRect.bottom
  ) {
    return null;
  }

  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) {
    return null;
  }

  const line = view.state.doc.lineAt(pos);
  if (pos === line.to) {
    const end = view.coordsAtPos(line.to);
    if (end && event.clientX > end.right + 2) {
      return null;
    }
  }
  return pos;
};

/** The anchor the pointer implies, or null when it is not over a turn. */
const anchorUnderPointer = (view: EditorView, event: MouseEvent): Anchor | null => {
  const pos = positionUnderPointer(view, event);
  if (pos === null) {
    return null;
  }

  const turn = turnAt(view.state.doc, pos);
  if (!turn) {
    return null;
  }

  const label = labelRange(view.state, turn);
  if (pos >= label.from && pos <= label.to) {
    return { kind: "label", from: label.from, to: label.to };
  }

  const index = wordIndexAt(turn, pos);
  if (index === null) {
    return null;
  }
  const span = wordSpans(turn)[index];
  return { kind: "word", wordFrom: span.from, wordTo: span.to, offset: 0 };
};

const applyAnchor = (view: EditorView, anchor: Anchor | null): void => {
  const current = view.state.field(anchorField);
  if (anchorsEqual(current, anchor)) {
    return;
  }

  const resolved = resolve(view.state, anchor);
  const selection = resolved
    ? EditorSelection.single(resolved.from, resolved.to)
    : EditorSelection.cursor(view.state.selection.main.from);

  view.dispatch({
    effects: setAnchor.of(anchor),
    selection,
    scrollIntoView: false,
    annotations: transcriptHoverSelection.of(true)
  });
};

/**
 * Blank-line repair for the lines the edit disturbed. Splits introduce turns
 * with no blank line between them and deletions leave two, so the spacing is
 * restored to the document's own convention — measured from `turn`'s neighbours
 * before the edit, and applied only within a window of the edit plus one turn
 * either side. Nothing outside that window is read or rewritten.
 */
const tidySpacing = (
  state: EditorState,
  turn: Turn,
  move: ChangeSet,
  editedFrom: number,
  editedTo: number
): ChangeSet => {
  const doc = move.apply(state.doc);
  const window = expandToNeighbouringTurns(
    doc,
    doc.lineAt(move.mapPos(editedFrom, -1)).number,
    doc.lineAt(move.mapPos(editedTo, 1)).number
  );

  return ChangeSet.of(
    normalizeTurnGaps(doc, window.from, window.to, detectTurnGap(state.doc, turn), state.lineBreak),
    doc.length
  );
};

/**
 * Commits an edit as exactly one undo step. These are multi-line surgeries and
 * must not decompose into separate entries; the spacing repair is composed into
 * the same transaction so it is not separately undoable either. The anchor
 * clears itself because the document changed.
 */
const applyEdit = (view: EditorView, turn: Turn, changes: DocChange[] | null): void => {
  if (!changes || changes.length === 0) {
    return;
  }

  const { state } = view;
  const move = state.changes(changes);
  const combined = move.compose(
    tidySpacing(state, turn, move, changes[0].from, changes[changes.length - 1].to)
  );

  view.dispatch({
    changes: combined,
    selection: EditorSelection.cursor(combined.mapPos(changes[0].from, -1)),
    userEvent: "transcript.move",
    annotations: [Transaction.addToHistory.of(true), isolateHistory.of("full")]
  });
};

const commit = (view: EditorView, resolved: Resolved): void => {
  const { doc, lineBreak } = view.state;
  const changes = resolved.kind === "label"
    ? buildLabelMerge(doc, resolved.turn, lineBreak)
    : buildWordMove(doc, resolved.turn, resolved.from, resolved.to, lineBreak);
  applyEdit(view, resolved.turn, changes);
};

const createEventHandlers = () => {
  const takeWheelSteps = createWheelAccumulator();

  return EditorView.domEventHandlers({
    mousemove(event, view) {
      const anchor = view.state.field(anchorField);
      // Once the selection is more than one word the anchor is frozen, so the
      // mouse can wander (or the text can scroll beneath it) without losing it.
      if (anchor?.kind === "word" && anchor.offset !== 0) {
        return false;
      }
      applyAnchor(view, anchorUnderPointer(view, event));
      return false;
    },

    wheel(event, view) {
      const anchor = view.state.field(anchorField);
      // Nothing anchored means the pointer is over the margin, a blank line or
      // non-turn text, which is how you scroll the document without leaving the
      // mode. Everything else the mode owns.
      if (!anchor) {
        return false;
      }

      // A label selection is atomic: there is no offset to extend, so the wheel
      // does nothing at all rather than falling through to word-anchoring.
      if (anchor.kind === "label") {
        event.preventDefault();
        return true;
      }

      const bounds = offsetBounds(view.state, anchor);
      if (!bounds) {
        return false;
      }

      event.preventDefault();
      const steps = takeWheelSteps(event, `${anchor.wordFrom}:${anchor.wordTo}`);
      if (steps === 0) {
        return true;
      }

      const offset = Math.max(bounds.min, Math.min(bounds.max, anchor.offset + steps));
      applyAnchor(view, { ...anchor, offset });
      return true;
    },

    mousedown(event, view) {
      if (event.button !== 0) {
        return false;
      }
      const resolved = resolve(view.state, view.state.field(anchorField));
      if (!resolved) {
        return false;
      }
      const pos = positionUnderPointer(view, event);
      if (pos === null || pos < resolved.from || pos > resolved.to) {
        return false;
      }

      // Claim the event even when the outcome is inert: the click must not fall
      // through to caret placement or start CodeMirror's drag of the selection.
      event.preventDefault();
      commit(view, resolved);
      return true;
    },

    contextmenu(event, view) {
      const resolved = resolve(view.state, view.state.field(anchorField));
      if (resolved?.kind !== "label") {
        return false;
      }
      const pos = positionUnderPointer(view, event);
      if (pos === null || pos < resolved.from || pos > resolved.to) {
        return false;
      }

      event.preventDefault();
      applyEdit(
        view,
        resolved.turn,
        buildTurnDelete(view.state.doc, resolved.turn, view.state.lineBreak)
      );
      return true;
    }
  });
};

const escapeKeymap = keymap.of([
  {
    key: "Escape",
    run: (view) => {
      const anchor = view.state.field(anchorField, false);
      if (!anchor) {
        return false;
      }
      applyAnchor(view, null);
      return true;
    }
  }
]);

const transcriptTheme = EditorView.baseTheme({
  // The mode owns the mouse, so drop the I-beam: it would promise ordinary
  // drag-selection, which hover-anchoring overrides.
  ".cm-transcript-mode": {
    cursor: "default"
  },
  ".cm-transcript-sel": {
    borderRadius: "2px"
  },
  ".cm-transcript-toPrevious, .cm-transcript-toNext": {
    cursor: "pointer"
  },
  ".cm-transcript-split": {
    cursor: "pointer"
  },
  ".cm-transcript-none": {
    cursor: "default"
  },
  ".cm-transcript-label": {
    cursor: "pointer"
  },
  ".cm-transcript-hint": {
    // Purely advisory: it must never intercept the click it is describing.
    pointerEvents: "none",
    marginLeft: "0.35em",
    fontSize: "0.85em",
    verticalAlign: "baseline",
    opacity: "0.9"
  },

  "&light .cm-transcript-toPrevious, &light .cm-transcript-toNext": {
    backgroundColor: "rgba(37, 99, 235, 0.20)",
    boxShadow: "inset 0 -2px 0 rgba(37, 99, 235, 0.75)"
  },
  "&light .cm-transcript-split": {
    backgroundColor: "rgba(217, 119, 6, 0.20)",
    boxShadow: "inset 0 -2px 0 rgba(217, 119, 6, 0.80)"
  },
  "&light .cm-transcript-none": {
    backgroundColor: "rgba(100, 116, 139, 0.16)"
  },
  "&light .cm-transcript-label": {
    backgroundColor: "rgba(220, 38, 38, 0.18)",
    boxShadow: "inset 0 -2px 0 rgba(220, 38, 38, 0.75)"
  },
  "&light .cm-transcript-hint": { color: "#b45309" },

  "&dark .cm-transcript-toPrevious, &dark .cm-transcript-toNext": {
    backgroundColor: "rgba(96, 165, 250, 0.26)",
    boxShadow: "inset 0 -2px 0 rgba(96, 165, 250, 0.85)"
  },
  "&dark .cm-transcript-split": {
    backgroundColor: "rgba(251, 191, 36, 0.24)",
    boxShadow: "inset 0 -2px 0 rgba(251, 191, 36, 0.85)"
  },
  "&dark .cm-transcript-none": {
    backgroundColor: "rgba(148, 163, 184, 0.20)"
  },
  "&dark .cm-transcript-label": {
    backgroundColor: "rgba(248, 113, 113, 0.24)",
    boxShadow: "inset 0 -2px 0 rgba(248, 113, 113, 0.85)"
  },
  "&dark .cm-transcript-hint": { color: "#fbbf24" }
});

/**
 * Builds the transcript-mode bundle. Install it through a compartment so the
 * mode can be switched on and off; nothing here runs while it is uninstalled.
 *
 * The handlers take high precedence so the context-menu handler is offered the
 * event before spellcheck's — all-caps speaker labels are prime candidates for
 * being flagged as misspelled, and the spelling menu would otherwise win the
 * right-click. It returns false whenever no label is selected, leaving
 * spellcheck's behaviour untouched.
 */
export const createTranscriptExtension = (): Extension => [
  anchorField,
  EditorView.decorations.compute([anchorField, "doc"], buildDecorations),
  Prec.high(createEventHandlers()),
  Prec.high(escapeKeymap),
  EditorView.contentAttributes.of({ class: "cm-transcript-mode" }),
  transcriptTheme
];
