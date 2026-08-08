import { describe, expect, it } from "vitest";
import { describeCueProblems } from "./cueProblems";
import type { CueProblem } from "./vtt";

describe("describing cue problems", () => {
  it("says nothing when there is nothing to say", () => {
    expect(describeCueProblems([])).toEqual([]);
  });

  it("counts the cues of each kind rather than listing them", () => {
    const problems: CueProblem[] = [
      { kind: "overlap", index: 3 },
      { kind: "overlap", index: 9 }
    ];

    expect(describeCueProblems(problems)).toEqual([
      "2 cues start before the one before them has ended."
    ]);
  });

  it("uses the singular for one", () => {
    expect(describeCueProblems([{ kind: "overlap", index: 3 }])[0]).toContain("1 cue ");
  });

  /** The one that means the wrong recording was chosen leads, and says so. */
  it("puts cues running past the recording first, and names the length", () => {
    const problems: CueProblem[] = [
      { kind: "overlap", index: 1 },
      { kind: "beyond-audio", index: 8, audioDuration: 125 }
    ];

    const lines = describeCueProblems(problems);

    expect(lines[0]).toContain("2:05");
    expect(lines[0]).toContain("different recording");
    expect(lines[1]).toContain("start before");
  });

  it("describes every kind it is given", () => {
    const problems: CueProblem[] = [
      { kind: "overlap", index: 1 },
      { kind: "out-of-order", index: 2 },
      { kind: "backwards", index: 3 },
      { kind: "beyond-audio", index: 4, audioDuration: 60 }
    ];

    expect(describeCueProblems(problems)).toHaveLength(4);
  });
});
