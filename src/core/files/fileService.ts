import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { exists, open as openFile, readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import type { TextFilePresence } from "../app/contracts";
import type { ConversionOutput } from "../tsf/conversionWatch";

export type OpenFileResult =
  | { kind: "cancelled" }
  | { kind: "opened"; filePath: string; text: string };

export type OpenFilePathResult =
  | { kind: "cancelled" }
  | { kind: "opened"; filePath: string };

export type SaveAsResult =
  | { kind: "cancelled" }
  | { kind: "saved"; filePath: string };

const normalizeDialogPath = (value: string | string[] | null): string | null => {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value;
};

const directoryFromPath = (filePath: string): string => {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash < 0) {
    return "";
  }
  if (lastSlash === 0) {
    return "/";
  }
  return filePath.slice(0, lastSlash);
};

const DEFAULT_STREAM_CHUNK_BYTES = 256 * 1024;
const MIN_STREAM_CHUNK_BYTES = 4 * 1024;
// Matches Rust's launch-stream clamp. Keep this bound here so direct file reads
// and launch reads have the same maximum allocation policy.
const MAX_STREAM_CHUNK_BYTES = 1024 * 1024;

export const normalizeStreamChunkSizeBytes = (chunkSizeBytes?: number): number => {
  if (typeof chunkSizeBytes !== "number" || !Number.isFinite(chunkSizeBytes)) {
    return DEFAULT_STREAM_CHUNK_BYTES;
  }
  const normalized = Math.floor(chunkSizeBytes);
  if (normalized < MIN_STREAM_CHUNK_BYTES) {
    return MIN_STREAM_CHUNK_BYTES;
  }
  return Math.min(normalized, MAX_STREAM_CHUNK_BYTES);
};

export const openTextFile = async (defaultPath?: string): Promise<OpenFileResult> => {
  const selectedPath = await openTextFilePath(defaultPath);
  if (selectedPath.kind === "cancelled") {
    return selectedPath;
  }

  const text = await readTextFile(selectedPath.filePath);
  return {
    kind: "opened",
    filePath: selectedPath.filePath,
    text
  };
};

export const openTextFilePath = async (defaultPath?: string): Promise<OpenFilePathResult> => {
  const selected = normalizeDialogPath(await openDialog({
    multiple: false,
    defaultPath: defaultPath || undefined
  }));

  if (!selected) {
    return { kind: "cancelled" };
  }

  return {
    kind: "opened",
    filePath: selected
  };
};

const openFilePathWithFilter = async (
  name: string,
  extensions: string[],
  defaultPath?: string,
  title?: string
): Promise<OpenFilePathResult> => {
  const selected = normalizeDialogPath(await openDialog({
    multiple: false,
    defaultPath: defaultPath || undefined,
    title,
    filters: [{ name, extensions }]
  }));
  return selected ? { kind: "opened", filePath: selected } : { kind: "cancelled" };
};

/**
 * The timed transcript an import starts from.
 *
 * VTT and SRT only: §5.1 of the plan settled the input surface deliberately,
 * and anything else would be a format Wisty cannot specify or test against
 * files it did not produce.
 */
export const openSubtitleFilePath = (defaultPath?: string) =>
  openFilePathWithFilter(
    "Timed transcript",
    ["vtt", "srt"],
    defaultPath,
    // An import asks three questions through three system dialogs, all of
    // which say "Open File" unless told otherwise. The title is the only part
    // of them Wisty can write, so it carries both the question and the count.
    "Import step 1 of 3: choose the transcript (VTT or SRT)"
  );

/**
 * The recording the transcript describes.
 *
 * Filtered generously, because the input surface is meant to be "any audio
 * file": what Wisty can actually read is settled by probing the file, which
 * reports a real reason, rather than by the name it happens to have.
 */
export const openAudioFilePath = (defaultPath?: string) =>
  openFilePathWithFilter(
    "Audio",
    ["m4a", "mp4", "aac", "mp3", "wav", "flac", "ogg", "opus", "webm", "mka"],
    defaultPath,
    "Import step 2 of 3: choose the recording"
  );

export const saveTextFileAs = async (text: string, defaultPath?: string): Promise<SaveAsResult> => {
  const selected = await saveTextFilePathAs(defaultPath);
  if (selected.kind === "cancelled") {
    return selected;
  }
  await writeTextFile(selected.filePath, text);
  return selected;
};

export const saveTextFilePathAs = async (defaultPath?: string): Promise<SaveAsResult> => {
  const selected = await save({ defaultPath: defaultPath || undefined });
  if (!selected) {
    return { kind: "cancelled" };
  }
  return {
    kind: "saved",
    filePath: selected
  };
};

const savePathWithExtension = async (defaultPath: string | undefined, name: string, extension: string, title?: string): Promise<SaveAsResult> => {
  const selected = await save({
    defaultPath: defaultPath || undefined,
    title,
    filters: [{ name, extensions: [extension] }]
  });
  if (!selected) return { kind: "cancelled" };
  const suffix = `.${extension}`;
  const lastDot = selected.lastIndexOf(".");
  const lastSeparator = selected.lastIndexOf("/");
  if (lastDot < lastSeparator) return { kind: "saved", filePath: `${selected}${suffix}` };
  if (!selected.toLowerCase().endsWith(suffix)) throw new Error(`Choose a ${suffix} file`);
  return { kind: "saved", filePath: selected };
};

/**
 * Where to write a container. The title is the caller's because this answers
 * two different questions: saving the open container elsewhere, and naming the
 * one an import is about to build.
 */
export const saveContainerPathAs = (defaultPath?: string, title?: string) =>
  savePathWithExtension(defaultPath, "Transcript container", "tsf", title);
export const saveTextExportPathAs = (defaultPath?: string) =>
  savePathWithExtension(defaultPath, "Plain text", "txt", "Export as plain text");

export const saveTextFile = async (filePath: string, text: string): Promise<void> => {
  await writeTextFile(filePath, text);
};

export const readTextFileAtPath = async (filePath: string): Promise<string> => {
  return readTextFile(filePath);
};

export const streamReadTextFileAtPath = async function* (
  filePath: string,
  options?: { chunkSizeBytes?: number }
): AsyncGenerator<{ text: string; bytesReadTotal: number; fileSizeBytes?: number }, void, void> {
  const fileInfo = await stat(filePath);
  const fileSizeBytes = fileInfo.size;
  const chunkSizeBytes = normalizeStreamChunkSizeBytes(options?.chunkSizeBytes);
  const buffer = new Uint8Array(chunkSizeBytes);
  // Fatal mode refuses non-UTF-8 input instead of silently substituting
  // replacement characters, which would corrupt the file on the next save.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const invalidUtf8Error = () =>
    new Error(`File is not valid UTF-8 text: '${filePath}'`);

  const handle = await openFile(filePath, { read: true });
  let bytesReadTotal = 0;

  try {
    while (true) {
      const readCount = await handle.read(buffer);
      if (readCount === null || readCount <= 0) {
        break;
      }

      bytesReadTotal += readCount;
      let text: string;
      try {
        text = decoder.decode(buffer.subarray(0, readCount), { stream: true });
      } catch {
        throw invalidUtf8Error();
      }
      if (text) {
        yield {
          text,
          bytesReadTotal,
          fileSizeBytes
        };
      }
    }

    let trailingText: string;
    try {
      trailingText = decoder.decode();
    } catch {
      throw invalidUtf8Error();
    }
    if (trailingText) {
      yield {
        text: trailingText,
        bytesReadTotal,
        fileSizeBytes
      };
    }
  } finally {
    await handle.close();
  }
};

export const getFileSize = async (filePath: string): Promise<number> => {
  const metadata = await stat(filePath);
  return metadata.size;
};

/**
 * Device and inode, unless the value cannot survive the trip.
 *
 * `stat` always reports both on Linux, but they arrive as JavaScript numbers,
 * and an inode past 2^53 — XFS on a large filesystem can produce one — would be
 * rounded on the way here and again on the way back to Rust. Comparing a
 * rounded identity is worse than not comparing one, so it is dropped and the
 * check stands on size and mtime.
 */
const safeFileIdentityNumber = (value: number | null): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** Treats an unanswerable question as "still there", so the original fault wins. */
const pathStillExists = async (filePath: string): Promise<boolean> => {
  try {
    return await exists(filePath);
  } catch {
    return true;
  }
};

/**
 * The modification time, unless it cannot be compared.
 *
 * An invalid `Date` yields `NaN`, and `NaN` never equals itself: recorded as a
 * version it would make the file differ from itself on every check, standing a
 * conflict up that nothing could clear and refusing every save. Dropping it
 * leaves the comparison to size and identity, which is the safe direction.
 */
const comparableModifiedMs = (value: Date | null | undefined): number | null => {
  const milliseconds = value?.getTime();
  return typeof milliseconds === "number" && Number.isFinite(milliseconds) ? milliseconds : null;
};

/**
 * What is at `filePath` now.
 *
 * A path with no file, and a path holding something that is not a file, are
 * both states the caller has to act on rather than faults, so they are
 * reported rather than thrown. Every other `stat` failure is a genuine fault
 * and propagates instead of being mistaken for a deletion. `stat` rejects for a
 * missing path and for a permissions fault alike, so the two are told apart by
 * asking whether the path is still there.
 */
export const getTextFilePresence = async (filePath: string): Promise<TextFilePresence> => {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(filePath);
  } catch (error) {
    if (await pathStillExists(filePath)) {
      throw error;
    }
    return { kind: "missing" };
  }
  if (!metadata.isFile) {
    return { kind: "not-a-file" };
  }
  return {
    kind: "present",
    version: {
      size: metadata.size,
      modifiedMs: comparableModifiedMs(metadata.mtime),
      device: safeFileIdentityNumber(metadata.dev),
      inode: safeFileIdentityNumber(metadata.ino)
    }
  };
};

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const metadata = await stat(filePath);
    return metadata.isFile;
  } catch {
    return false;
  }
};

export const getDirectoryFromFilePath = (filePath: string): string => directoryFromPath(filePath);

/** The extension a transcript container carries. */
export const CONTAINER_EXTENSION = "tsf";

/**
 * Whether a path names a transcript container.
 *
 * By extension, because this decides which way to *read* the file, and the
 * alternative is opening every file twice. The Rust side checks the actual zip
 * signature before trusting the contents, so a mislabelled file is caught
 * there with a message that says so.
 */
export const isContainerPath = (filePath: string): boolean =>
  filePath.toLowerCase().endsWith(`.${CONTAINER_EXTENSION}`);

export type OpenContainerResult = {
  /** The document text: the transcript, with its time markers. */
  transcript: string;
  meta: Record<string, unknown>;
  audioBytes: number;
};

/**
 * Opens a container, returning its transcript and metadata.
 *
 * The recording stays in Rust, held for the document's lifetime. It is never
 * sent across the bridge: it is tens of megabytes, and nothing on this side
 * has any use for the bytes.
 */
export const openContainer = async (filePath: string): Promise<OpenContainerResult> => {
  const result = await invoke<{
    transcript: string;
    meta: Record<string, unknown>;
    audio_bytes: number;
  }>("open_tsf", { path: filePath });
  return { transcript: result.transcript, meta: result.meta, audioBytes: result.audio_bytes };
};

/** Releases the open container, freeing the audio Rust was holding. */
export const closeContainer = async (): Promise<void> => {
  await invoke("close_tsf");
};

export const saveContainer = async (filePath: string, transcript: string): Promise<void> => {
  await invoke("save_tsf", { path: filePath, transcript });
};

/** What a recording says about itself, read before a container is built from it. */
export type AudioFacts = {
  /** Seconds, read from the file rather than taken on trust. */
  duration: number;
  codec: string;
};

export const probeAudioFile = async (filePath: string): Promise<AudioFacts> =>
  invoke<AudioFacts>("probe_audio_file", { path: filePath });

export type CreateContainerParams = {
  outputPath: string;
  transcript: string;
  audioPath: string;
  meta: Record<string, unknown>;
  /** Word timings, when the transcript came with any. */
  words?: string;
};

export type CreateContainerResult = {
  path: string;
  duration: number;
  codec: string;
  bytes: number;
};

/**
 * Builds a container from a transcript and a recording.
 *
 * The audio is named by path rather than passed: Rust copies it into the
 * archive without it ever crossing the bridge, as everywhere else the recording
 * is involved.
 */
export const createContainer = async (
  params: CreateContainerParams
): Promise<CreateContainerResult> =>
  invoke<CreateContainerResult>("create_tsf", {
    outputPath: params.outputPath,
    transcript: params.transcript,
    audioPath: params.audioPath,
    meta: params.meta,
    words: params.words
  });

/**
 * Whatever the conversion has said since this was last called.
 *
 * Polled rather than pushed: it needs no event permission and no listener to
 * unregister, and a conversion lasts seconds. The lines are ffmpeg's own.
 */
export const takeConversionOutput = async (): Promise<ConversionOutput> =>
  invoke<ConversionOutput>("take_conversion_output");

/** Stops the conversion, and with it the import that asked for it. */
export const cancelAudioConversion = async (): Promise<void> => {
  await invoke("cancel_audio_conversion");
};
