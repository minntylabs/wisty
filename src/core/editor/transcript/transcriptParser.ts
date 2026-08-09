/**
 * Turn/word segmentation for diarized interview transcripts, where every line
 * is one speaker turn introduced by a label prefix:
 *
 *     ALICE: so I went there and then he said
 *     BOB: it was fine
 *
 * Everything here is pure and works against a structural view of the document
 * (see DocLines), so the whole module is testable without CodeMirror.
 */

import { excludeMarkers, parseMarkers } from "../../tsf/markers";

/** One line of the document. CodeMirror's `Line` satisfies this structurally. */
export type DocLine = {
  number: number;
  from: number;
  to: number;
  text: string;
};

/** The document surface the parser needs. CodeMirror's `Text` satisfies this. */
export type DocLines = {
  readonly length: number;
  readonly lines: number;
  line: (lineNumber: number) => DocLine;
  lineAt: (pos: number) => DocLine;
};

export type Turn = {
  /** 1-based line number, as CodeMirror numbers them. */
  lineNumber: number;
  /** Document offsets of the whole line. */
  from: number;
  to: number;
  /**
   * The label as it will be reused when creating new turns: name, colon and
   * the original inter-word gap, e.g. "ALICE: " or "ALICE:  ". Any leading
   * bracketed timestamp is deliberately excluded — copying a stale timestamp
   * onto a newly created turn would be worse than having none.
   */
  labelText: string;
  /** Speaker identity, used only for comparing turns. */
  speaker: string;
  /** Document offsets of the turn's text, i.e. everything after the label. */
  textFrom: number;
  textTo: number;
  text: string;
};

export type WordSpan = {
  from: number;
  to: number;
};

/**
 * An optional bracketed prefix (a timestamp, typically), then the speaker name
 * up to the first colon, then the gap before the text. The name is length-capped
 * and checked by `isPlausibleSpeakerName` so ordinary prose containing a colon
 * ("Well, I told him: it's fine") is not mistaken for a turn.
 */
const LABEL_PATTERN = /^(\[[^\]\n]*\][ \t]*)?([^:\n]{1,60}):([ \t]*)/;

/** Sentence punctuation never appears in a speaker label but is common in prose. */
const PROSE_PUNCTUATION = /[.!?,;]/;

const isPlausibleSpeakerName = (name: string): boolean => {
  const trimmed = name.trim();
  return trimmed.length > 0 && !PROSE_PUNCTUATION.test(trimmed);
};

export const isBlankLine = (text: string): boolean => text.trim().length === 0;

/** Parses one line into a turn, or returns null when it carries no speaker label. */
export const parseTurnLine = (line: DocLine): Turn | null => {
  const match = LABEL_PATTERN.exec(line.text);
  if (!match) {
    return null;
  }

  const [whole, , name, gap] = match;
  if (!isPlausibleSpeakerName(name)) {
    return null;
  }

  const textFrom = line.from + whole.length;
  return {
    lineNumber: line.number,
    from: line.from,
    to: line.to,
    labelText: `${name}:${gap}`,
    speaker: name.trim(),
    textFrom,
    textTo: line.to,
    text: line.text.slice(whole.length)
  };
};

/** The turn containing `pos`, or null when that line is not a turn. */
export const turnAt = (doc: DocLines, pos: number): Turn | null =>
  parseTurnLine(doc.lineAt(Math.max(0, Math.min(doc.length, pos))));

/**
 * Walks away from `turn` in `step` direction to the nearest other turn. Blank
 * lines are skipped; a non-blank line that is not a turn ends the search, since
 * treating unrelated prose as a neighbouring turn would move text into it.
 */
const adjacentTurn = (doc: DocLines, turn: Turn, step: -1 | 1): Turn | null => {
  for (
    let lineNumber = turn.lineNumber + step;
    lineNumber >= 1 && lineNumber <= doc.lines;
    lineNumber += step
  ) {
    const line = doc.line(lineNumber);
    if (isBlankLine(line.text)) {
      continue;
    }
    return parseTurnLine(line);
  }
  return null;
};

/**
 * Widens a line range to take in the nearest non-blank line on each side, which
 * for a transcript is the neighbouring turn. This is what keeps the blank-line
 * normalisation local: the window is the edit plus one turn either way, never
 * the whole document.
 */
export const expandToNeighbouringTurns = (
  doc: DocLines,
  firstLine: number,
  lastLine: number
): { from: number; to: number } => {
  const walk = (start: number, step: -1 | 1): number => {
    for (let lineNumber = start + step; lineNumber >= 1 && lineNumber <= doc.lines; lineNumber += step) {
      if (!isBlankLine(doc.line(lineNumber).text)) {
        return lineNumber;
      }
    }
    return Math.max(1, Math.min(doc.lines, step === -1 ? 1 : doc.lines));
  };

  return { from: walk(firstLine, -1), to: walk(lastLine, 1) };
};

export const previousTurn = (doc: DocLines, turn: Turn): Turn | null => adjacentTurn(doc, turn, -1);

export const nextTurn = (doc: DocLines, turn: Turn): Turn | null => adjacentTurn(doc, turn, 1);

/**
 * The turn's words, as absolute document offsets. A word is a whitespace-
 * delimited token: punctuation, brackets and annotations such as "[inaudible]"
 * travel with the token they are attached to, which is what the reader sees
 * and therefore what they expect to move.
 *
 * Time markers are then cut back out. A .tsf writes them flush against the
 * sentence they introduce — "⟦734.12–736.80⟧So we walked" — so splitting on
 * whitespace alone hands back a first word with the token welded to its front.
 * Left in, that token would be highlighted on hover, selectable as a word, and
 * reattributed to the other speaker as though it were one.
 *
 * Excluding it is also what leaves a click on an icon unclaimed, so the
 * marker's own widget receives it rather than tidy mode swallowing it.
 *
 * Plain .txt transcripts have no markers, and `excludeMarkers` returns its
 * input unchanged in that case, so this costs them one scan and nothing else.
 */
export const wordSpans = (turn: Turn): WordSpan[] => {
  const spans: WordSpan[] = [];
  const pattern = /\S+/g;
  for (let match = pattern.exec(turn.text); match; match = pattern.exec(turn.text)) {
    spans.push({
      from: turn.textFrom + match.index,
      to: turn.textFrom + match.index + match[0].length
    });
  }
  // Markers are parsed from the turn's own text rather than passed in, so every
  // existing caller stays marker-aware without knowing markers exist. The turn
  // is one line, and this runs on hover rather than per keystroke.
  return excludeMarkers(spans, parseMarkers(turn.text, turn.textFrom));
};

/** Index into `wordSpans(turn)` of the word covering `pos`, or null. */
export const wordIndexAt = (turn: Turn, pos: number): number | null => {
  const spans = wordSpans(turn);
  const index = spans.findIndex((span) => pos >= span.from && pos <= span.to);
  return index === -1 ? null : index;
};

export type SpeakerIndex = {
  /** Distinct speakers in first-appearance order. */
  speakers: string[];
  /** First-seen label text per speaker, so new turns reuse the real formatting. */
  labelTextBySpeaker: Map<string, string>;
};

/**
 * The last index built, keyed by the document it was built from.
 *
 * That comment above used to say "only needed on commit, not on hover", and it
 * was not true: classifying a word selection asks for the other speaker's
 * label, and classification runs on every mouse move — so hovering scanned the
 * whole document, once per pointer movement, plus again for the decorations.
 *
 * A `Text` is immutable and persistent, so its identity is a sound key: the
 * same document object always has the same speakers, and any edit produces a
 * different one. Weak so a document that has been replaced is not held here.
 */
const speakerIndexes = new WeakMap<DocLines, SpeakerIndex>();

/** Scans the whole document for its speakers. Memoised per document. */
export const indexSpeakers = (doc: DocLines): SpeakerIndex => {
  const cached = speakerIndexes.get(doc);
  if (cached) {
    return cached;
  }

  const speakers: string[] = [];
  const labelTextBySpeaker = new Map<string, string>();

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    const turn = parseTurnLine(doc.line(lineNumber));
    if (!turn || labelTextBySpeaker.has(turn.speaker)) {
      continue;
    }
    speakers.push(turn.speaker);
    labelTextBySpeaker.set(turn.speaker, turn.labelText);
  }

  const index = { speakers, labelTextBySpeaker };
  speakerIndexes.set(doc, index);
  return index;
};

/**
 * The label text to give a turn that is not `turn`'s speaker, resolved without
 * ever guessing: the document's other speaker when there are exactly two, else
 * a differing neighbour's label, else null (the caller must then do nothing).
 * Diarizers emit SPEAKER_00/SPEAKER_01 and a bad run can introduce a stray
 * third label, so the two-speaker assumption is checked rather than trusted.
 */
export const resolveOtherSpeakerLabel = (doc: DocLines, turn: Turn): string | null => {
  const { speakers, labelTextBySpeaker } = indexSpeakers(doc);

  if (speakers.length === 2) {
    const other = speakers.find((speaker) => speaker !== turn.speaker);
    if (other) {
      return labelTextBySpeaker.get(other) ?? null;
    }
  }

  for (const neighbour of [nextTurn(doc, turn), previousTurn(doc, turn)]) {
    if (neighbour && neighbour.speaker !== turn.speaker) {
      return neighbour.labelText;
    }
  }

  return null;
};
