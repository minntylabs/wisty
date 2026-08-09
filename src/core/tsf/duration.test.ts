import { describe, expect, it } from "vitest";
import { formatDuration } from "./duration";
import { describeCueProblems } from "./cueProblems";

describe("writing a length of recording", () => {
  it("uses minutes and seconds under an hour", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(90)).toBe("1:30");
    expect(formatDuration(3599)).toBe("59:59");
  });

  /**
   * The bug this replaced: the import's own copy of this had no hours branch,
   * so a ninety-minute interview — the ordinary case for this app — was
   * reported as being "90:00 long".
   */
  it("uses hours past the hour", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(5400)).toBe("1:30:00");
    expect(formatDuration(7325)).toBe("2:02:05");
  });

  it("does not print a negative or unreadable length", () => {
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("the cue problems that quote a length", () => {
  it("reports a long recording in hours", () => {
    const lines = describeCueProblems([
      { kind: "beyond-audio", index: 3, audioDuration: 5400 }
    ]);
    expect(lines[0]).toContain("1:30:00 long");
  });
});
