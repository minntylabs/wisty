import { beforeEach, describe, expect, it, vi } from "vitest";

const dialogSave = vi.hoisted(() => vi.fn());
const fsStat = vi.hoisted(() => vi.fn());
const fsExists = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: dialogSave
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: fsExists,
  open: vi.fn(),
  readTextFile: vi.fn(),
  stat: fsStat,
  writeTextFile: vi.fn()
}));

import {
  getTextFilePresence,
  isContainerPath,
  normalizeStreamChunkSizeBytes,
  saveContainerPathAs,
  saveTextExportPathAs
} from "./fileService";

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

describe("Save As extensions", () => {
  /**
   * The dot that matters is the one in the file name. A dotted directory —
   * `~/my.exports/transcript` — has a dot after no extension at all, and
   * mistaking it for one would refuse a perfectly good path.
   */
  it("appends the requested extension when only a directory carries a dot", async () => {
    dialogSave.mockResolvedValueOnce("/home/dan/my.exports/transcript");
    await expect(saveContainerPathAs()).resolves.toEqual({
      kind: "saved",
      filePath: "/home/dan/my.exports/transcript.tsf"
    });

    dialogSave.mockResolvedValueOnce("/home/dan/my.exports/export");
    await expect(saveTextExportPathAs()).resolves.toEqual({
      kind: "saved",
      filePath: "/home/dan/my.exports/export.txt"
    });
  });
});

describe("getTextFilePresence", () => {
  beforeEach(() => {
    fsStat.mockReset();
    fsExists.mockReset();
  });

  it("reads size, mtime and identity from a file", async () => {
    fsStat.mockResolvedValueOnce({ isFile: true, size: 12, mtime: new Date(1_000), dev: 3, ino: 7 });

    await expect(getTextFilePresence("/tmp/notes.txt")).resolves.toEqual({
      kind: "present",
      version: { size: 12, modifiedMs: 1_000, device: 3, inode: 7 }
    });
  });

  it("reports a deleted file as missing rather than failing", async () => {
    // Tauri's `stat` rejects for a missing path, so deletion arrives as an
    // error and would otherwise be indistinguishable from a real fault.
    fsStat.mockRejectedValueOnce(new Error("No such file or directory (os error 2)"));
    fsExists.mockResolvedValueOnce(false);

    await expect(getTextFilePresence("/tmp/notes.txt")).resolves.toEqual({ kind: "missing" });
  });

  it("propagates a failure on a path that is still there", async () => {
    fsStat.mockRejectedValueOnce(new Error("Permission denied (os error 13)"));
    fsExists.mockResolvedValueOnce(true);

    await expect(getTextFilePresence("/tmp/notes.txt")).rejects.toThrow("Permission denied");
  });

  it("propagates the original failure when the path cannot be checked either", async () => {
    fsStat.mockRejectedValueOnce(new Error("Permission denied (os error 13)"));
    fsExists.mockRejectedValueOnce(new Error("forbidden"));

    await expect(getTextFilePresence("/tmp/notes.txt")).rejects.toThrow("Permission denied");
  });

  /**
   * Kept apart from a missing path: a file that has gone can be recreated
   * where it was, and a directory standing in its place cannot be written over
   * at all, so the two cannot share a description or a way out.
   */
  it("reports a path replaced by a directory as its own state", async () => {
    fsStat.mockResolvedValueOnce({ isFile: false, size: 0, mtime: null, dev: null, ino: null });

    await expect(getTextFilePresence("/tmp/notes.txt")).resolves.toEqual({ kind: "not-a-file" });
  });

  /**
   * `NaN` never equals itself, so a version carrying one would differ from
   * itself on every check: a conflict nothing could clear, and a save that
   * could never proceed. Dropping it leaves size and identity to compare.
   */
  it("drops a modification time that cannot be compared", async () => {
    fsStat.mockResolvedValueOnce({
      isFile: true,
      size: 12,
      mtime: new Date(Number.NaN),
      dev: 3,
      ino: 7
    });

    await expect(getTextFilePresence("/tmp/notes.txt")).resolves.toEqual({
      kind: "present",
      version: { size: 12, modifiedMs: null, device: 3, inode: 7 }
    });
  });
});

describe("stream chunk limits", () => {
  it("stays within the backend launch-stream allocation bounds", () => {
    expect(normalizeStreamChunkSizeBytes()).toBe(256 * 1024);
    expect(normalizeStreamChunkSizeBytes(1)).toBe(4 * 1024);
    expect(normalizeStreamChunkSizeBytes(2 * 1024 * 1024)).toBe(1024 * 1024);
  });
});
