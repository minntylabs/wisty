/**
 * Classifies a transcript selection into the edit it will perform, and builds
 * that edit. Pure: no CodeMirror, no view, no dispatch — the extension layer
 * turns the returned changes into a transaction.
 *
 * Every operation rewrites whole turn-text regions rather than splicing around
 * the moved words. Rewriting is what keeps whitespace correct without a pile of
 * separator special cases, and it is trivially non-overlapping.
 */

import {
  type DocLines,
  type Turn,
  isBlankLine,
  nextTurn,
  parseTurnLine,
  previousTurn,
  resolveOtherSpeakerLabel,
  wordSpans
} from "./transcriptParser";

export type DocChange = {
  from: number;
  to: number;
  insert: string;
};

/**
 * What a left-click on the current selection will do.
 *
 * "none" covers both "the selection spans the whole turn" and "the recipient
 * this move needs does not exist", so the affordance can show a single honest
 * inert state without the caller re-deriving feasibility.
 */
export type WordOutcome = "toPrevious" | "toNext" | "split" | "none";

const joinText = (...parts: string[]): string =>
  parts.map((part) => part.trim()).filter((part) => part.length > 0).join(" ");

const replaceTurnText = (turn: Turn, insert: string): DocChange => ({
  from: turn.textFrom,
  to: turn.textTo,
  insert
});

/** Splits a turn's text at the selection, in turn-relative coordinates. */
const zones = (turn: Turn, from: number, to: number) => ({
  head: turn.text.slice(0, from - turn.textFrom),
  body: turn.text.slice(from - turn.textFrom, to - turn.textFrom),
  tail: turn.text.slice(to - turn.textFrom)
});

/**
 * Which of the four cases a word selection falls into. Reaching both ends is
 * inert by design: it is what makes a turn unable to donate all its words, so
 * empty turns are structurally impossible and no dangling-label case exists.
 */
export const classifyWordSelection = (
  doc: DocLines,
  turn: Turn,
  from: number,
  to: number
): WordOutcome => {
  const spans = wordSpans(turn);
  if (spans.length === 0) {
    return "none";
  }

  const reachesStart = from <= spans[0].from;
  const reachesEnd = to >= spans[spans.length - 1].to;

  if (reachesStart && reachesEnd) {
    return "none";
  }
  if (reachesStart) {
    return previousTurn(doc, turn) ? "toPrevious" : "none";
  }
  if (reachesEnd) {
    return nextTurn(doc, turn) ? "toNext" : "none";
  }
  return resolveOtherSpeakerLabel(doc, turn) ? "split" : "none";
};

/**
 * The edit for a left-click on a word selection, or null when the selection is
 * inert. `lineBreak` is the document's line separator.
 */
export const buildWordMove = (
  doc: DocLines,
  turn: Turn,
  from: number,
  to: number,
  lineBreak: string
): DocChange[] | null => {
  const outcome = classifyWordSelection(doc, turn, from, to);
  const { head, body, tail } = zones(turn, from, to);

  if (outcome === "toPrevious") {
    const recipient = previousTurn(doc, turn);
    if (!recipient) {
      return null;
    }
    // Recipient precedes the donor, so the changes are already in ascending order.
    return [
      replaceTurnText(recipient, joinText(recipient.text, body)),
      replaceTurnText(turn, joinText(head, tail))
    ];
  }

  if (outcome === "toNext") {
    const recipient = nextTurn(doc, turn);
    if (!recipient) {
      return null;
    }
    return [
      replaceTurnText(turn, joinText(head, tail)),
      replaceTurnText(recipient, joinText(body, recipient.text))
    ];
  }

  if (outcome === "split") {
    const otherLabel = resolveOtherSpeakerLabel(doc, turn);
    const [zone1, zone2, zone3] = [head.trim(), body.trim(), tail.trim()];
    if (!otherLabel || !zone1 || !zone2 || !zone3) {
      return null;
    }
    return [
      replaceTurnText(
        turn,
        `${zone1}${lineBreak}${otherLabel}${zone2}${lineBreak}${turn.labelText}${zone3}`
      )
    ];
  }

  return null;
};

/** Whether a left-click on the label can merge this turn into the one above. */
export const canMergeIntoPrevious = (doc: DocLines, turn: Turn): boolean =>
  previousTurn(doc, turn) !== null;

/**
 * Left-click on a selected label: drop the label and append the turn's text to
 * the previous turn, removing the now-empty line.
 *
 * Deliberately not gated on the previous turn having a different speaker —
 * consecutive same-speaker turns occur in diarizer output and are also created
 * by the three-way split, and merging into a same-speaker predecessor is the
 * useful inverse of that split.
 */
export const buildLabelMerge = (
  doc: DocLines,
  turn: Turn,
  lineBreak: string
): DocChange[] | null => {
  const recipient = previousTurn(doc, turn);
  if (!recipient) {
    return null;
  }

  return [
    replaceTurnText(recipient, joinText(recipient.text, turn.text)),
    // Take the preceding line break with the line. A previous turn exists, so
    // there is always one to take; any blank lines in between are preserved.
    { from: turn.from - lineBreak.length, to: turn.to, insert: "" }
  ];
};

/**
 * How many blank lines this document puts between turns, judged from the edited
 * turn's own neighbours rather than a whole-file survey. Any blank line at all
 * means the transcript is blank-separated and normalises to exactly one; none
 * means it is densely packed and must stay that way.
 */
export const detectTurnGap = (doc: DocLines, turn: Turn): number => {
  for (const neighbour of [previousTurn(doc, turn), nextTurn(doc, turn)]) {
    if (neighbour && Math.abs(neighbour.lineNumber - turn.lineNumber) > 1) {
      return 1;
    }
  }
  return 0;
};

/**
 * Forces exactly `gap` blank lines between each pair of adjacent turns in
 * [fromLine, lastLine]. Only pairs separated purely by blank lines are touched:
 * any other content between two turns resets the pairing, so unrelated prose is
 * never closed up.
 *
 * Runs against the post-edit document, since it is the edit that disturbs the
 * spacing — a split introduces no blank lines and a deletion leaves two.
 */
export const normalizeTurnGaps = (
  doc: DocLines,
  fromLine: number,
  lastLine: number,
  gap: number,
  lineBreak: string
): DocChange[] => {
  const changes: DocChange[] = [];
  let previous: Turn | null = null;

  for (let lineNumber = fromLine; lineNumber <= lastLine; lineNumber++) {
    const line = doc.line(lineNumber);
    if (isBlankLine(line.text)) {
      continue;
    }

    const turn = parseTurnLine(line);
    if (!turn) {
      previous = null;
      continue;
    }

    if (previous && turn.lineNumber - previous.lineNumber - 1 !== gap) {
      changes.push({ from: previous.to, to: turn.from, insert: lineBreak.repeat(gap + 1) });
    }
    previous = turn;
  }

  return changes;
};

/** Right-click on a selected label: delete the whole turn, label and text. */
export const buildTurnDelete = (
  doc: DocLines,
  turn: Turn,
  lineBreak: string
): DocChange[] => {
  if (turn.from >= lineBreak.length) {
    return [{ from: turn.from - lineBreak.length, to: turn.to, insert: "" }];
  }
  if (turn.to + lineBreak.length <= doc.length) {
    return [{ from: turn.from, to: turn.to + lineBreak.length, insert: "" }];
  }
  // Only line in the document: clear it rather than leave a stray break.
  return [{ from: turn.from, to: turn.to, insert: "" }];
};
