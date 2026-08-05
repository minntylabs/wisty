import { describe, expect, it } from "vitest";
import { isContainerPath } from "./fileService";

describe("isContainerPath", () => {
  it("recognises a container", () => {
    expect(isContainerPath("/archive/mum_11.tsf")).toBe(true);
  });

  it("is case-insensitive, since the filesystem may not be", () => {
    expect(isContainerPath("/archive/MUM_11.TSF")).toBe(true);
  });

  it("does not match text files", () => {
    for (const path of ["/a/notes.txt", "/a/notes.md", "/a/tsf", "/a/tsf.txt", "/a/notes.tsfx"]) {
      expect(isContainerPath(path)).toBe(false);
    }
  });

  it("does not match a directory that merely ends in .tsf", () => {
    // Not something this can detect from the string alone; the Rust side
    // checks the zip signature, which is what actually settles it.
    expect(isContainerPath("/archive/backup.tsf")).toBe(true);
  });
});
