import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type { DocLines } from "./transcriptParser";
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

  it("returns the plain text spans untouched when there are no markers", () => {
    // The regression that matters: plain .txt transcripts are already in use,
    // and tidy mode must behave for them exactly as it did before markers
    // existed. excludeMarkers returns its input when the marker list is empty,
    // so this is a property of the code rather than a hope.
    const { turn } = turnOnLine(SAMPLE, 1);
    expect(wordSpans(turn)).toEqual([
      { from: 7, to: 9 },
      { from: 10, to: 11 },
      { from: 12, to: 16 },
      { from: 17, to: 22 },
      { from: 23, to: 26 },
      { from: 27, to: 31 },
      { from: 32, to: 34 },
      { from: 35, to: 39 }
    ]);
  });
});

describe("word segmentation with time markers", () => {
  const wordsOf = (turn: { text: string; textFrom: number }, spans: { from: number; to: number }[]) =>
    spans.map((span) => turn.text.slice(span.from - turn.textFrom, span.to - turn.textFrom));

  it("drops the marker and keeps the word it is welded to", () => {
    // Markers are written flush against their sentence, so splitting on
    // whitespace alone would produce "⟦734.12–736.80⟧So" as a single word.
    const { turn } = turnOnLine("ALICE: ⟦734.12–736.80⟧So we walked", 1);
    expect(wordsOf(turn, wordSpans(turn))).toEqual(["So", "we", "walked"]);
  });

  it("handles several markers in one turn", () => {
    const { turn } = turnOnLine(
      "ALICE: ⟦734.12–736.80⟧So we walked. ⟦736.80–740.15⟧And then it rained.",
      1
    );
    expect(wordsOf(turn, wordSpans(turn)))
      .toEqual(["So", "we", "walked.", "And", "then", "it", "rained."]);
  });

  it("splits a word that a marker sits inside rather than dropping its tail", () => {
    // Not something the writer produces, but an edit can leave a marker mid-word
    // and losing the text after it would be silent.
    const { turn } = turnOnLine("ALICE: wal⟦734.12–736.80⟧ked on", 1);
    expect(wordsOf(turn, wordSpans(turn))).toEqual(["wal", "ked", "on"]);
  });

  it("leaves no word at all where a marker stands alone", () => {
    const { turn } = turnOnLine("ALICE: hello ⟦734.12–736.80⟧ there", 1);
    expect(wordsOf(turn, wordSpans(turn))).toEqual(["hello", "there"]);
  });

  it("reports no word under a marker, so a click on its icon goes unclaimed", () => {
    // This is what lets the marker's own widget receive the click instead of
    // tidy mode selecting a word and swallowing it.
    const { turn } = turnOnLine("ALICE: ⟦734.12–736.80⟧So we walked", 1);
    const markerMiddle = turn.textFrom + 5;
    expect(wordIndexAt(turn, markerMiddle)).toBeNull();
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

describe("indexing the document's speakers", () => {
  /**
   * Classifying a word selection asks for the other speaker's label, and
   * classification runs on every mouse move — so this used to walk the whole
   * document once per pointer movement, and again for the decorations.
   */
  it("scans a document once however often it is asked", () => {
    const doc = docOf("ALICE: one\nBOB: two\nALICE: three");
    let reads = 0;
    const counted: DocLines = {
      get length() {
        return doc.length;
      },
      get lines() {
        return doc.lines;
      },
      line: (lineNumber: number) => {
        reads += 1;
        return doc.line(lineNumber);
      },
      lineAt: (pos: number) => doc.lineAt(pos)
    };

    const first = indexSpeakers(counted);
    const readsAfterFirst = reads;
    const second = indexSpeakers(counted);

    expect(first.speakers).toEqual(["ALICE", "BOB"]);
    expect(second).toBe(first);
    expect(reads, "the document was walked again").toBe(readsAfterFirst);
  });

  it("indexes a changed document afresh", () => {
    // A Text is immutable, so an edit produces a different object — which is
    // exactly what must not be answered from the previous one's cache.
    const before = docOf("ALICE: one");
    const after = docOf("ALICE: one\nBOB: two");

    expect(indexSpeakers(before).speakers).toEqual(["ALICE"]);
    expect(indexSpeakers(after).speakers).toEqual(["ALICE", "BOB"]);
  });
});
