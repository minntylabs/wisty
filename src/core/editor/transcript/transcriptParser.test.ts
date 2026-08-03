import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import {
  indexSpeakers,
  nextTurn,
  parseTurnLine,
  previousTurn,
  resolveOtherSpeakerLabel,
  turnAt,
  wordIndexAt,
  wordSpans
} from "./transcriptParser";

const docOf = (text: string) => Text.of(text.split("\n"));

const turnOnLine = (text: string, lineNumber: number) => {
  const doc = docOf(text);
  const turn = parseTurnLine(doc.line(lineNumber));
  if (!turn) {
    throw new Error(`line ${lineNumber} is not a turn`);
  }
  return { doc, turn };
};

const SAMPLE = "ALICE: so I went there and then he said\nBOB: it was fine";

describe("parseTurnLine", () => {
  it("splits a labelled line into label and text", () => {
    const { turn } = turnOnLine(SAMPLE, 1);
    expect(turn.speaker).toBe("ALICE");
    expect(turn.labelText).toBe("ALICE: ");
    expect(turn.text).toBe("so I went there and then he said");
    expect(turn.textFrom).toBe(7);
  });

  it("preserves non-uniform label spacing verbatim", () => {
    const { turn } = turnOnLine("ALICE:   padded out", 1);
    expect(turn.labelText).toBe("ALICE:   ");
    expect(turn.text).toBe("padded out");
  });

  it("keeps the speaker identity but drops a leading timestamp from the label", () => {
    const { turn } = turnOnLine("[00:12:31] ALICE: hello there", 1);
    expect(turn.speaker).toBe("ALICE");
    expect(turn.labelText).toBe("ALICE: ");
    expect(turn.text).toBe("hello there");
  });

  it("does not mistake prose containing a colon for a turn", () => {
    const doc = docOf("Well, I told him: it's fine");
    expect(parseTurnLine(doc.line(1))).toBeNull();
  });

  it("returns null for a line with no colon", () => {
    const doc = docOf("just some text");
    expect(parseTurnLine(doc.line(1))).toBeNull();
  });

  it("treats a label with no text as a turn with empty text", () => {
    const { turn } = turnOnLine("ALICE:", 1);
    expect(turn.text).toBe("");
    expect(wordSpans(turn)).toEqual([]);
  });
});

describe("word segmentation", () => {
  it("treats whitespace-delimited tokens as words, punctuation included", () => {
    const { turn } = turnOnLine("ALICE: don't [inaudible] half-hour, yes", 1);
    const { text, textFrom } = turn;
    expect(wordSpans(turn).map((span) => text.slice(span.from - textFrom, span.to - textFrom)))
      .toEqual(["don't", "[inaudible]", "half-hour,", "yes"]);
  });

  it("finds the word covering a position and nothing outside the text", () => {
    const { turn } = turnOnLine(SAMPLE, 1);
    expect(wordIndexAt(turn, 7)).toBe(0);
    expect(wordIndexAt(turn, 13)).toBe(2);
    expect(wordIndexAt(turn, 39)).toBe(7);
    expect(wordIndexAt(turn, 100)).toBeNull();
  });
});

describe("turn navigation", () => {
  it("locates the turn containing a position", () => {
    const doc = docOf(SAMPLE);
    expect(turnAt(doc, 45)?.speaker).toBe("BOB");
    expect(turnAt(doc, 0)?.speaker).toBe("ALICE");
  });

  it("skips blank lines between turns", () => {
    const doc = docOf("ALICE: one\n\n\nBOB: two");
    const second = turnAt(doc, doc.line(4).from);
    expect(previousTurn(doc, second!)?.speaker).toBe("ALICE");
    expect(nextTurn(doc, previousTurn(doc, second!)!)?.speaker).toBe("BOB");
  });

  it("stops at a non-blank line that is not a turn", () => {
    const doc = docOf("ALICE: one\n--- break ---\nBOB: two");
    const second = turnAt(doc, doc.line(3).from);
    expect(previousTurn(doc, second!)).toBeNull();
  });

  it("returns null past the ends of the document", () => {
    const doc = docOf(SAMPLE);
    expect(previousTurn(doc, turnAt(doc, 0)!)).toBeNull();
    expect(nextTurn(doc, turnAt(doc, 45)!)).toBeNull();
  });
});

describe("speaker resolution", () => {
  it("indexes distinct speakers in first-appearance order", () => {
    const doc = docOf("BOB: one\nALICE: two\nBOB: three");
    expect(indexSpeakers(doc).speakers).toEqual(["BOB", "ALICE"]);
  });

  it("returns the other label when the document has exactly two speakers", () => {
    const doc = docOf(SAMPLE);
    expect(resolveOtherSpeakerLabel(doc, turnAt(doc, 0)!)).toBe("BOB: ");
  });

  it("falls back to a differing neighbour when there are more than two speakers", () => {
    const doc = docOf("ALICE: one\nBOB: two\nCARLA: three");
    const bob = turnAt(doc, doc.line(2).from)!;
    expect(resolveOtherSpeakerLabel(doc, bob)).toBe("CARLA: ");
  });

  it("refuses to guess when the document has a single speaker", () => {
    const doc = docOf("ALICE: one\nALICE: two");
    expect(resolveOtherSpeakerLabel(doc, turnAt(doc, 0)!)).toBeNull();
  });
});
