import { describe, it, expect } from "vitest";
import { formatErrorDetails } from "./errorDetails";

describe("formatting error details", () => {
  it("prints a captured log as lines, not as escapes", () => {
    // The reason this module exists. JSON.stringify turns a log into a single
    // quoted line of \n, which is unreadable in the panel and useless pasted
    // into a bug report.
    const formatted = formatErrorDetails({
      ffmpegOutput: ["Input #0, mov,mp4", "Stream mapping:", "[aac] Invalid data"]
    });
    expect(formatted).toBe("ffmpegOutput:\nInput #0, mov,mp4\nStream mapping:\n[aac] Invalid data");
    expect(formatted).not.toContain("\\n");
    expect(formatted).not.toContain('"');
  });

  it("prints an already-joined log the same way", () => {
    // The caller has joined the lines before now and may again; a string with
    // breaks in it is still a log.
    expect(formatErrorDetails({ output: "one\ntwo" })).toBe("output:\none\ntwo");
  });

  it("keeps short values on one line", () => {
    expect(formatErrorDetails({ path: "/tmp/rec.tsf", cues: 412, cancelled: false })).toBe(
      "path: /tmp/rec.tsf\n\ncues: 412\n\ncancelled: false"
    );
  });

  it("still uses JSON for something genuinely structured", () => {
    expect(formatErrorDetails({ range: { start: 1, end: 2 } })).toBe(
      'range:\n{\n  "start": 1,\n  "end": 2\n}'
    );
  });

  it("separates entries so a log does not run into the next key", () => {
    const formatted = formatErrorDetails({ log: ["a", "b"], path: "/tmp/x" });
    expect(formatted).toBe("log:\na\nb\n\npath: /tmp/x");
  });

  it("says nothing when there is nothing to say", () => {
    // The caller tests this to decide whether to offer Details and Copy at all.
    expect(formatErrorDetails({})).toBe("");
    expect(formatErrorDetails(null)).toBe("");
    expect(formatErrorDetails(undefined)).toBe("");
  });

  it("reports an empty log rather than an empty heading", () => {
    expect(formatErrorDetails({ ffmpegOutput: [] })).toBe("ffmpegOutput: (none)");
  });

  it("survives a value that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatErrorDetails({ circular })).toBe("circular: (cannot be shown)");
  });
});
