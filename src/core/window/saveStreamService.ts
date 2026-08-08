import { invoke } from "@tauri-apps/api/core";
import type { TextFileVersion } from "../app/contracts";

export type SaveFileStreamStartResult = {
  streamId: string;
  filePath: string;
};

export type SaveFileStreamWriteResult = {
  bytesWrittenTotal: number;
};

export type SaveFileStreamFinishResult = {
  bytesWrittenTotal: number;
};

export const startSaveFileStream = async (
  filePath: string,
  expectedSource?: TextFileVersion
): Promise<SaveFileStreamStartResult> => {
  return invoke<SaveFileStreamStartResult>("start_save_file_stream", expectedSource
    ? { filePath, expectedSource }
    : { filePath });
};

export const writeSaveFileChunk = async (
  streamId: string,
  textChunk: string
): Promise<SaveFileStreamWriteResult> => {
  return invoke<SaveFileStreamWriteResult>("write_save_file_chunk", { streamId, textChunk });
};

export const finishSaveFileStream = async (
  streamId: string
): Promise<SaveFileStreamFinishResult> => {
  return invoke<SaveFileStreamFinishResult>("finish_save_file_stream", { streamId });
};

export const cancelSaveFileStream = async (streamId: string): Promise<void> => {
  await invoke<void>("cancel_save_file_stream", { streamId });
};
