/**
 * WebVTT and SubRip (SRT) parsing, for importing a timed transcript into a
 * .tsf container.
 *
 *     WEBVTT
 *
 *     00:12:14.120 --> 00:12:16.800
 *     <v ALICE>So we walked down to Bath.
 *
 * VTT is the import contract because it is a standard, it is what nearly every
 * captioning tool emits, and its voice spans carry the speaker — which is
 * everything a .tsf needs. Formats that are one tool's invention, or a family
 * of near-variants that drift between versions, are deliberately not accepted.
 *
 * SRT is accepted as the same cue structure without voice spans, so an
 * SRT-derived transcript has no speaker labels.
 *
 * Pure: no CodeMirror, no file system, no Tauri.
 */

export type Cue = {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** Cue text, joined to a single line, with any voice span removed. */
  text: string;
  /** From a `<v NAME>` voice span. Absent for SRT and for unmarked VTT cues. */
  speaker?: string;
  /**
   * Set when the file gave an end before the start, and the span was collapsed
   * rather than the whole transcript being discarded. `validateCues` reports
   * these; a cue that is simply instantaneous is not one of them.
   */
  clamped?: true;
};

export class SubtitleParseError extends Error {}

/**
 * `HH:MM:SS.mmm` or `MM:SS.mmm`, comma or dot before the milliseconds. VTT
 * specifies a dot and SRT a comma; both appear in the wild in either form, and
 * accepting both costs nothing.
 */
const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

/** The cue timing line, e.g. `00:12:14.120 --> 00:12:16.800 align:start`. */
const TIMING_LINE = /^(\S+)\s*-->\s*(\S+)(?:\s+.*)?$/;

const parseTimestamp = (value: string): number => {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) {
    throw new SubtitleParseError(`Not a timestamp: ${value}`);
  }
  const [, hours, minutes, seconds, fraction] = match;
  // "1" means 100ms, "12" 120ms, "123" 123ms — pad rather than divide by a
  // length-dependent power of ten.
  const milliseconds = Number(fraction.padEnd(3, "0"));
  return (
    Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + milliseconds / 1000
  );
};

/** A voice span: `<v ALICE>`, or `<v.loud ALICE>` with classes. */
const VOICE_SPAN = /<v(?:\.[^\s>]*)*\s+([^>]*)>/g;

type Segment = { speaker?: string; text: string };

/**
 * Splits a cue payload into one segment per speaker.
 *
 * WebVTT permits a speaker change inside a single cue, and usually there is at
 * most one voice span at the start. Handling the general case matters because
 * the alternative is worse than not parsing the file at all: a second span
 * would be stripped as ordinary markup and its words attributed to the first
 * speaker — a silent misattribution, which is the exact fault this whole
 * feature exists to let someone correct.
 *
 * A closing `</v>` is optional in the spec and is removed wherever it appears.
 */
const splitBySpeaker = (payload: string): Segment[] => {
  const pattern = new RegExp(VOICE_SPAN.source, "g");
  const segments: Segment[] = [];
  let lastIndex = 0;
  let speaker: string | undefined;

  const push = (text: string, who?: string) => {
    const cleaned = text.replace(/<\/v>/g, "").trim();
    if (cleaned) {
      segments.push(who ? { speaker: who, text: cleaned } : { text: cleaned });
    }
  };

  for (let match = pattern.exec(payload); match !== null; match = pattern.exec(payload)) {
    push(payload.slice(lastIndex, match.index), speaker);
    const name = decodeEntities(match[1].trim());
    speaker = name || undefined;
    lastIndex = match.index + match[0].length;
  }
  push(payload.slice(lastIndex), speaker);

  return segments;
};

/** Removes any other VTT inline markup (<b>, <i>, <c.classname>, timestamps). */
const stripInlineTags = (text: string): string => text.replace(/<[^>]*>/g, "");

/**
 * The character escapes a cue payload may contain.
 *
 * `&amp;` is decoded last, so `&amp;lt;` yields the literal text `&lt;` rather than
 * a `<`. Decoding it first would let one escape produce another and change the text.
 */
const ENTITIES: [RegExp, string][] = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&nbsp;/g, " "],
  [/&lrm;/g, "‎"],
  [/&rlm;/g, "‏"],
  [/&amp;/g, "&"]
];

const decodeEntities = (text: string): string =>
  ENTITIES.reduce((result, [pattern, character]) => result.replace(pattern, character), text);

/**
 * Blocks separated by blank lines. Handles CRLF, a `WEBVTT` header, and the
 * `NOTE`/`STYLE`/`REGION` blocks VTT allows, which are skipped.
 */
const splitBlocks = (source: string): string[][] =>
  source
    .replace(/\r\n?/g, "\n")
    .replace(/^﻿/, "")
    .split(/\n{2,}/)
    .map((block) => block.split("\n").filter((line) => line.trim().length > 0))
    .filter((lines) => lines.length > 0);

/**
 * Every cue in a VTT or SRT document, in file order.
 *
 * Cues are returned exactly as written: overlapping or out-of-order cues are
 * not repaired here, because silently reordering someone's transcript would be
 * worse than reporting it. `validateCues` is where that judgement lives.
 */
export const parseSubtitles = (source: string): Cue[] => {
  const cues: Cue[] = [];

  for (const lines of splitBlocks(source)) {
    // A block is a cue if it contains a timing line, wherever that line sits.
    // Deciding instead from the block's first word — WEBVTT, NOTE, STYLE,
    // REGION — and skipping the whole block loses any cue that follows one of
    // those without the blank line the spec asks for: the first cue of a file
    // whose header runs straight into it would vanish, silently. Anything
    // before the timing line is a header, a note, or the cue's own optional
    // identifier, and none of them are needed.
    //
    // Safe because the spec forbids `-->` inside note text for exactly this
    // reason, so a line containing one is a cue timing line and nothing else.
    const timingIndex = lines.findIndex((line) => TIMING_LINE.test(line));
    if (timingIndex === -1) {
      continue;
    }
    const timing = TIMING_LINE.exec(lines[timingIndex]);
    if (!timing) {
      continue;
    }

    const start = parseTimestamp(timing[1]);
    // A cue that ends before it starts keeps its text and loses its span.
    // Throwing would discard an entire transcript over one bad timing, and the
    // words are the part worth keeping; a marker with nothing to play is
    // visibly useless, where a guessed end would be quietly wrong.
    // `validateCues` reports it as `zero-length` so it can be surfaced before a
    // container is written.
    const declaredEnd = parseTimestamp(timing[2]);
    const end = Math.max(start, declaredEnd);
    const clamped = declaredEnd < start;

    const body = lines.slice(timingIndex + 1).join(" ").trim();
    if (!body) {
      continue;
    }
    // One cue per speaker segment. Segments share the cue's times: the file
    // says when the cue was spoken, not when each speaker within it was, and
    // dividing the span by text length would be inventing timings. Playing
    // either segment replays the whole cue, which is the same trade made
    // elsewhere — hearing slightly too much is harmless, attributing words to
    // the wrong person is not.
    for (const segment of splitBySpeaker(body)) {
      // Tags are stripped before entities are decoded, so a `&lt;b&gt;` in the
      // transcript survives as literal text rather than becoming markup to remove.
      const cleaned = decodeEntities(stripInlineTags(segment.text))
        .replace(/\s+/g, " ")
        .trim();
      if (!cleaned) {
        continue;
      }
      const cue: Cue = segment.speaker
        ? { start, end, text: cleaned, speaker: segment.speaker }
        : { start, end, text: cleaned };
      cues.push(clamped ? { ...cue, clamped } : cue);
    }
  }

  if (cues.length === 0) {
    throw new SubtitleParseError("No cues found — is this a VTT or SRT file?");
  }
  return cues;
};

export type CueProblem =
  | { kind: "out-of-order"; index: number }
  | { kind: "overlap"; index: number }
  | { kind: "backwards"; index: number }
  | { kind: "beyond-audio"; index: number; audioDuration: number };

/**
 * Problems worth telling the user about before writing a container.
 *
 * None of these are fatal — a marker whose span is a little wrong still plays
 * roughly the right passage, and a transcript with one odd cue is far better
 * than no transcript. They are reported so a mismatched pair of files (this
 * VTT, that recording) is caught before it becomes a .tsf, which is the
 * likeliest real mistake here.
 */
export const validateCues = (cues: readonly Cue[], audioDuration?: number): CueProblem[] => {
  const problems: CueProblem[] = [];
  cues.forEach((cue, index) => {
    const previous = cues[index - 1];
    // An identical span is not an overlap: it is a second speaker within one
    // cue, which parseSubtitles splits into segments sharing the cue's times.
    const sameCue = previous && cue.start === previous.start && cue.end === previous.end;
    if (previous && cue.start < previous.start) {
      problems.push({ kind: "out-of-order", index });
    } else if (previous && !sameCue && cue.start < previous.end) {
      problems.push({ kind: "overlap", index });
    }
    // Only a span the file got impossibly wrong. An instantaneous cue is not a
    // problem: whisper emits a few per recording where a word's start and end
    // coincide, and the playback padding still gives half a second to hear.
    if (cue.clamped) {
      problems.push({ kind: "backwards", index });
    }
    if (audioDuration !== undefined && cue.start > audioDuration) {
      problems.push({ kind: "beyond-audio", index, audioDuration });
    }
  });
  return problems;
};
