import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  cancelLaunchFileStream,
  closeLaunchFileStream,
  readLaunchFileChunk,
  startLaunchFileStream,
  takeLaunchFileArg
} from "./launchArgService";

describe("launch argument service", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("returns no launch argument when the backend is unavailable", async () => {
    invoke.mockRejectedValueOnce(new Error("not running in Tauri"));
    await expect(takeLaunchFileArg()).resolves.toBeNull();
  });

  it("forwards launch stream operations to their matching commands", async () => {
    invoke
      .mockResolvedValueOnce({ streamId: "launch-1", filePath: "/tmp/a.txt", fileSizeBytes: 4 })
      .mockResolvedValueOnce({ kind: "chunk", text: "text", bytesReadTotal: 4, fileSizeBytes: 4 })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await expect(startLaunchFileStream("/tmp/a.txt")).resolves.toMatchObject({ streamId: "launch-1" });
    await expect(readLaunchFileChunk("launch-1", 4096)).resolves.toMatchObject({ kind: "chunk", text: "text" });
    await cancelLaunchFileStream("launch-1");
    await closeLaunchFileStream("launch-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "start_launch_file_stream", { filePath: "/tmp/a.txt" });
    expect(invoke).toHaveBeenNthCalledWith(2, "read_launch_file_chunk", { streamId: "launch-1", maxBytes: 4096 });
    expect(invoke).toHaveBeenNthCalledWith(3, "cancel_launch_file_stream", { streamId: "launch-1" });
    expect(invoke).toHaveBeenNthCalledWith(4, "close_launch_file_stream", { streamId: "launch-1" });
  });
});
