import { describe, expect, it } from "vitest";
import { buildTranscript, speakerLabel, UNNAMED_SPEAKER } from "./transcriptBuilder";
import { parseSubtitles } from "./vtt";
import { parseMarkers } from "./markers";
import { parseTurnLine, wordSpans } from "../editor/transcript/transcriptParser";

const VTT = `WEBVTT

00:12:14.120 --> 00:12:16.800
<v ALICE>So we walked down to Bath.

00:12:16.800 --> 00:12:20.150
<v ALICE>And then it rained.

00:12:22.900 --> 00:12:25.300
<v BOB>Did you?
`;

const build = (vtt: string) => buildTranscript(parseSubtitles(vtt));

describe("buildTranscript", () => {
  it("writes one marker per cue, flush against its text", () => {
    expect(build(VTT)).toBe(
      "ALICE: ⟦734.12–736.80⟧So we walked down to Bath. ⟦736.80–740.15⟧And then it rained." +
        "\n\n" +
        "BOB: ⟦742.90–745.30⟧Did you?"
    );
  });

  it("joins consecutive cues from one speaker into a single turn", () => {
    const text = build(VTT);
    expect(text.split("\n\n")).toHaveLength(2);
  });

  it("starts a new turn when the speaker changes", () => {
    const text = build(VTT);
    expect(text.split("\n\n")[1].startsWith("BOB: ")).toBe(true);
  });

  it("omits the label when cues carry no speaker (SRT)", () => {
    const text = buildTranscript(
      parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\nNo speaker here.\n")
    );
    expect(text).toBe("⟦1.00–2.00⟧No speaker here.");
  });

  it("preserves cue times exactly rather than re-timing anything", () => {
    const markers = parseMarkers(build(VTT));
    expect(markers.map((m) => [m.start, m.end])).toEqual([
      [734.12, 736.8],
      [736.8, 740.15],
      [742.9, 745.3]
    ]);
  });
});

/**
 * The output has to be readable by the code that already exists, or the
 * importer produces files the editor mishandles. These are the two places
 * where a marker in the wrong position would break something silently.
 */
describe("output is compatible with the existing transcript parser", () => {
  const text = build(VTT);
  const lines = text.split("\n");
  const docLine = (index: number) => {
    const from = lines.slice(0, index).reduce((total, line) => total + line.length + 1, 0);
    return { number: index + 1, from, to: from + lines[index].length, text: lines[index] };
  };

  it("still parses as speaker turns", () => {
    const turn = parseTurnLine(docLine(0));
    expect(turn).not.toBeNull();
    expect(turn?.speaker).toBe("ALICE");
  });

  it("never places a marker before the speaker label", () => {
    // A line-leading marker makes LABEL_PATTERN read it as part of the name,
    // which PROSE_PUNCTUATION then rejects for containing a full stop.
    for (const line of lines.filter((candidate) => candidate.trim().length > 0)) {
      expect(line.startsWith("⟦")).toBe(false);
    }
  });

  it("leaves every marker flush against the following word", () => {
    for (const marker of parseMarkers(text)) {
      expect(text[marker.to]).not.toBe(" ");
      expect(text[marker.to]).not.toBe(undefined);
    }
  });

  it("keeps markers out of every word span", () => {
    // wordSpans splits on whitespace, which would weld a flush marker onto the
    // front of the word it introduces; it then cuts the markers back out. A
    // marker is machinery, not a word, so nothing may select or move it as one.
    const turn = parseTurnLine(docLine(0));
    const spans = wordSpans(turn!);
    for (const marker of parseMarkers(text)) {
      const overlapping = spans.find(
        (span) => span.from < marker.to && span.to > marker.from
      );
      expect(overlapping).toBeUndefined();
    }
  });

  it("leaves the introduced word as a span of its own, starting after the marker", () => {
    // The other half of flush placement: cutting the marker out must leave the
    // word behind rather than dropping the span, or the first word of every
    // sentence would become unreachable to tidy mode.
    const turn = parseTurnLine(docLine(0));
    const spans = wordSpans(turn!);
    const firstMarker = parseMarkers(text)[0];
    expect(spans.some((span) => span.from === firstMarker.to)).toBe(true);
  });
});

/**
 * A speaker name comes from someone else's file and lands in a position the
 * transcript parser reads structurally. These are the ways a name taken
 * verbatim would break it, all of them quietly.
 */
describe("speaker names are made safe for the transcript parser", () => {
  const speakerOf = (vtt: string) => {
    const text = build(vtt);
    const line = text.split("\n")[0];
    const turn = parseTurnLine({ number: 1, from: 0, to: line.length, text: line });
    return turn?.speaker;
  };
  const cue = (name: string) =>
    `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v ${name}>Some words here.\n`;

  it("a colon would otherwise split the name and misattribute the turn", () => {
    expect(speakerLabel("Interviewer: Jane")).toBe("Interviewer - Jane");
    expect(speakerOf(cue("Interviewer: Jane"))).toBe("Interviewer - Jane");
  });

  it("a full stop would otherwise stop the line being a turn at all", () => {
    expect(speakerLabel("Dr. Smith")).toBe("Dr Smith");
    expect(speakerOf(cue("Dr. Smith"))).toBe("Dr Smith");
  });

  it("a comma likewise", () => {
    expect(speakerOf(cue("Smith, John"))).toBe("Smith John");
  });

  it("marker characters would otherwise become a marker on the label", () => {
    // The brackets and full stops go, so what is left cannot form a token. The
    // remaining digits are mangled but harmless — the point is that the
    // document contains one marker, the sentence's, and not a second one
    // sitting in a speaker's name.
    const text = build(cue("A⟦1.00–2.00⟧B"));
    expect(parseMarkers(text)).toHaveLength(1);
    expect(speakerOf(cue("A⟦1.00–2.00⟧B"))).toBe("A100–200B");
  });

  it("a name longer than the parser accepts is truncated to fit", () => {
    const long = "Wilhelmina ".repeat(20).trim();
    expect(speakerLabel(long).length).toBeLessThanOrEqual(60);
    expect(speakerOf(cue(long))).toBe(speakerLabel(long));
  });

  it("ordinary names are left exactly as they are", () => {
    for (const name of ["ALICE", "SPEAKER_00", "Jane Smith", "Interviewer 2"]) {
      expect(speakerLabel(name)).toBe(name);
    }
  });

  /**
   * Leaving the line unlabelled was the old behaviour and it is the failure
   * this function exists to prevent: the words lose their speaker with nothing
   * to show it happened. A placeholder keeps the turn a turn — still separate
   * from its neighbours, still parsed as a turn, and obviously in want of a
   * name — which is a thing someone can find and correct.
   */
  it("a name that sanitises away becomes a visible placeholder", () => {
    const text = build(cue("..."));
    expect(text.startsWith(":")).toBe(false);
    expect(text).toBe(`${UNNAMED_SPEAKER}: ⟦1.00–2.00⟧Some words here.`);
  });

  it("keeps two unnameable speakers apart rather than merging them", () => {
    // Both clean away to the placeholder, but they are still different people
    // and their turns must not run together into one.
    const text = buildTranscript([
      { start: 1, end: 2, text: "First.", speaker: "..." },
      { start: 2, end: 3, text: "Second.", speaker: "???" }
    ]);
    expect(text.split("\n\n")).toHaveLength(2);
  });
});
