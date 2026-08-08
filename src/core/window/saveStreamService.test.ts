import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  cancelSaveFileStream,
  finishSaveFileStream,
  startSaveFileStream,
  writeSaveFileChunk
} from "./saveStreamService";

describe("save stream service", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("forwards the complete save protocol to Rust", async () => {
    invoke
      .mockResolvedValueOnce({ streamId: "save-1", filePath: "/tmp/a.txt" })
      .mockResolvedValueOnce({ bytesWrittenTotal: 4 })
      .mockResolvedValueOnce({ bytesWrittenTotal: 4 })
      .mockResolvedValueOnce(undefined);

    await expect(startSaveFileStream("/tmp/a.txt")).resolves.toMatchObject({ streamId: "save-1" });
    await expect(writeSaveFileChunk("save-1", "text")).resolves.toEqual({ bytesWrittenTotal: 4 });
    await expect(finishSaveFileStream("save-1")).resolves.toEqual({ bytesWrittenTotal: 4 });
    await cancelSaveFileStream("save-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "start_save_file_stream", { filePath: "/tmp/a.txt" });
    expect(invoke).toHaveBeenNthCalledWith(2, "write_save_file_chunk", { streamId: "save-1", textChunk: "text" });
    expect(invoke).toHaveBeenNthCalledWith(3, "finish_save_file_stream", { streamId: "save-1" });
    expect(invoke).toHaveBeenNthCalledWith(4, "cancel_save_file_stream", { streamId: "save-1" });
  });

  it("forwards an expected source version for a protected overwrite", async () => {
    invoke.mockResolvedValueOnce({ streamId: "save-1", filePath: "/tmp/a.txt" });
    const expectedSource = {
      kind: "present" as const,
      version: { size: 4, modifiedMs: 1_000, device: 1, inode: 2 }
    };

    await startSaveFileStream("/tmp/a.txt", expectedSource);

    expect(invoke).toHaveBeenCalledWith("start_save_file_stream", {
      filePath: "/tmp/a.txt",
      expectedSource
    });
  });

  it("forwards the absent assertion a document being created makes", async () => {
    invoke.mockResolvedValueOnce({ streamId: "save-1", filePath: "/tmp/a.txt" });

    await startSaveFileStream("/tmp/a.txt", { kind: "absent" });

    expect(invoke).toHaveBeenCalledWith("start_save_file_stream", {
      filePath: "/tmp/a.txt",
      expectedSource: { kind: "absent" }
    });
  });
});
