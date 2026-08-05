import { describe, expect, it } from "vitest";
import { buildTranscript } from "./transcriptBuilder";
import { parseSubtitles } from "./vtt";
import { parseMarkers } from "../editor/markers/markerParser";
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

  it("keeps markers inside a word span, so the move rule can carry them", () => {
    // wordSpans splits on whitespace and knows nothing of markers; a flush
    // marker therefore belongs to the same span as the word it introduces.
    const turn = parseTurnLine(docLine(0));
    const spans = wordSpans(turn!);
    const firstMarker = parseMarkers(text)[0];
    const covering = spans.find(
      (span) => span.from <= firstMarker.from && span.to >= firstMarker.to
    );
    expect(covering).toBeDefined();
  });
});
