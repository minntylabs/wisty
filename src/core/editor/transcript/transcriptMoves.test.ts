import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { turnAt } from "./transcriptParser";
import { expandToNeighbouringTurns } from "./transcriptParser";
import {
  type DocChange,
  buildLabelMerge,
  buildTurnDelete,
  buildWordMove,
  canMergeIntoPrevious,
  classifyWordSelection,
  detectTurnGap,
  normalizeTurnGaps
} from "./transcriptMoves";

const docOf = (text: string) => Text.of(text.split("\n"));

/** Applies non-overlapping ascending changes back-to-front. */
const apply = (text: string, changes: DocChange[] | null): string => {
  if (!changes) {
    return text;
  }
  return [...changes]
    .sort((a, b) => b.from - a.from)
    .reduce((acc, change) => acc.slice(0, change.from) + change.insert + acc.slice(change.to), text);
};

const SAMPLE = "ALICE: so I went there and then he said\nBOB: it was fine";

/** Document offsets of the given text, which must appear exactly once. */
const rangeOf = (doc: string, needle: string) => {
  const from = doc.indexOf(needle);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(doc.indexOf(needle, from + 1)).toBe(-1);
  return { from, to: from + needle.length };
};

const move = (text: string, needle: string) => {
  const doc = docOf(text);
  const { from, to } = rangeOf(text, needle);
  const turn = turnAt(doc, from)!;
  return {
    outcome: classifyWordSelection(doc, turn, from, to),
    result: apply(text, buildWordMove(doc, turn, from, to, "\n"))
  };
};

describe("word selection classification", () => {
  it("reaching the turn start moves to the previous turn", () => {
    expect(move(SAMPLE, "it was").outcome).toBe("toPrevious");
  });

  it("reaching the turn end moves to the next turn", () => {
    expect(move(SAMPLE, "and then he said").outcome).toBe("toNext");
  });

  it("reaching neither end splits the turn in three", () => {
    expect(move(SAMPLE, "went there").outcome).toBe("split");
  });

  it("reaching both ends is inert, so a turn can never donate all its words", () => {
    expect(move(SAMPLE, "so I went there and then he said").outcome).toBe("none");
  });

  it("is inert when the recipient turn does not exist", () => {
    expect(move(SAMPLE, "so I").outcome).toBe("none");
    expect(move(SAMPLE, "was fine").outcome).toBe("none");
  });

  it("is inert when the other speaker cannot be resolved", () => {
    expect(move("ALICE: one two three\nALICE: four", "two").outcome).toBe("none");
  });

  it("treats a single word as first, last, or middle", () => {
    expect(move(SAMPLE, "it").outcome).toBe("toPrevious");
    expect(move(SAMPLE, "said").outcome).toBe("toNext");
    expect(move(SAMPLE, "went").outcome).toBe("split");
  });
});

describe("word moves", () => {
  it("appends to the end of the previous turn", () => {
    expect(move(SAMPLE, "it was").result)
      .toBe("ALICE: so I went there and then he said it was\nBOB: fine");
  });

  it("prefixes to the start of the next turn", () => {
    expect(move(SAMPLE, "and then he said").result)
      .toBe("ALICE: so I went there\nBOB: and then he said it was fine");
  });

  it("splits into three turns, alternating the label and restoring the original", () => {
    expect(move(SAMPLE, "went there").result).toBe(
      "ALICE: so I\nBOB: went there\nALICE: and then he said\nBOB: it was fine"
    );
  });

  it("leaves no double spaces behind when taking words from the middle of a turn", () => {
    const text = "ALICE: one two three\nBOB: four";
    expect(move(text, "three").result).toBe("ALICE: one two\nBOB: three four");
    expect(move("BOB: four\nALICE: one two three", "one").result)
      .toBe("BOB: four one\nALICE: two three");
  });

  it("does not touch capitalisation or punctuation at the new boundary", () => {
    const text = "ALICE: I said. Then he left.\nBOB: yes";
    expect(move(text, "Then he left.").result).toBe("ALICE: I said.\nBOB: Then he left. yes");
  });

  it("reuses the other speaker's real label formatting when splitting", () => {
    const text = "ALICE: one two three\nBOB:    four";
    expect(move(text, "two").result).toBe("ALICE: one\nBOB:    two\nALICE: three\nBOB:    four");
  });
});

describe("blank-line normalisation", () => {
  const normalize = (text: string) => {
    const doc = docOf(text);
    const turn = turnAt(doc, 0)!;
    const window = expandToNeighbouringTurns(doc, 1, doc.lines);
    return apply(text, normalizeTurnGaps(doc, window.from, window.to, detectTurnGap(doc, turn), "\n"));
  };

  it("detects the document's convention from the edited turn's neighbours", () => {
    const packed = docOf("ALICE: a\nBOB: b");
    const spaced = docOf("ALICE: a\n\nBOB: b");
    expect(detectTurnGap(packed, turnAt(packed, 0)!)).toBe(0);
    expect(detectTurnGap(spaced, turnAt(spaced, 0)!)).toBe(1);
  });

  it("collapses a doubled blank line left by a deletion", () => {
    expect(normalize("ALICE: a\n\n\nCARLA: c")).toBe("ALICE: a\n\nCARLA: c");
  });

  it("inserts the missing blank lines a split leaves behind", () => {
    expect(normalize("ALICE: a\n\nBOB: b\nALICE: c\nBOB: d"))
      .toBe("ALICE: a\n\nBOB: b\n\nALICE: c\n\nBOB: d");
  });

  it("leaves a densely packed transcript packed", () => {
    expect(normalize("ALICE: a\nBOB: b\nALICE: c")).toBe("ALICE: a\nBOB: b\nALICE: c");
  });

  it("does not close up non-turn content between turns", () => {
    const text = "ALICE: a\n\n--- tape change ---\n\n\nBOB: b";
    expect(normalize(text)).toBe(text);
  });

  it("is a no-op when the spacing is already correct", () => {
    const doc = docOf("ALICE: a\n\nBOB: b\n\nCARLA: c");
    expect(normalizeTurnGaps(doc, 1, doc.lines, 1, "\n")).toEqual([]);
  });
});

describe("window expansion", () => {
  it("takes in the nearest non-blank line on each side", () => {
    const doc = docOf("ALICE: a\n\nBOB: b\n\nCARLA: c");
    expect(expandToNeighbouringTurns(doc, 3, 3)).toEqual({ from: 1, to: 5 });
  });

  it("clamps at the document edges", () => {
    const doc = docOf("ALICE: a\n\nBOB: b");
    expect(expandToNeighbouringTurns(doc, 1, 3)).toEqual({ from: 1, to: 3 });
  });
});

describe("label operations", () => {
  const labelTurn = (text: string, lineNumber: number) => {
    const doc = docOf(text);
    return { doc, turn: turnAt(doc, doc.line(lineNumber).from)! };
  };

  it("merges a turn into the one above and removes its line", () => {
    const { doc, turn } = labelTurn(SAMPLE, 2);
    expect(apply(SAMPLE, buildLabelMerge(doc, turn, "\n")))
      .toBe("ALICE: so I went there and then he said it was fine");
  });

  it("merges into a same-speaker predecessor, undoing a split", () => {
    const text = "ALICE: one\nALICE: two";
    const { doc, turn } = labelTurn(text, 2);
    expect(canMergeIntoPrevious(doc, turn)).toBe(true);
    expect(apply(text, buildLabelMerge(doc, turn, "\n"))).toBe("ALICE: one two");
  });

  it("preserves blank lines between turns when merging", () => {
    const text = "ALICE: one\n\nBOB: two";
    const { doc, turn } = labelTurn(text, 3);
    expect(apply(text, buildLabelMerge(doc, turn, "\n"))).toBe("ALICE: one two\n");
  });

  it("cannot merge the first turn in the document", () => {
    const { doc, turn } = labelTurn(SAMPLE, 1);
    expect(canMergeIntoPrevious(doc, turn)).toBe(false);
    expect(buildLabelMerge(doc, turn, "\n")).toBeNull();
  });

  it("deletes a whole turn, taking its line with it", () => {
    const { doc, turn } = labelTurn(SAMPLE, 2);
    expect(apply(SAMPLE, buildTurnDelete(doc, turn, "\n")))
      .toBe("ALICE: so I went there and then he said");
  });

  it("deletes the first turn without leaving a leading blank line", () => {
    const { doc, turn } = labelTurn(SAMPLE, 1);
    expect(apply(SAMPLE, buildTurnDelete(doc, turn, "\n"))).toBe("BOB: it was fine");
  });

  it("clears the only line rather than leaving a stray break", () => {
    const text = "ALICE: alone";
    const { doc, turn } = labelTurn(text, 1);
    expect(apply(text, buildTurnDelete(doc, turn, "\n"))).toBe("");
  });
});
