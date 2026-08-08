import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { open as openFile, readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";

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
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) {
    return "";
  }
  if (lastSlash === 0) {
    return "/";
  }
  return normalized.slice(0, lastSlash);
};

const DEFAULT_STREAM_CHUNK_BYTES = 256 * 1024;
const MIN_STREAM_CHUNK_BYTES = 4 * 1024;

const normalizeChunkSizeBytes = (chunkSizeBytes?: number): number => {
  if (typeof chunkSizeBytes !== "number" || !Number.isFinite(chunkSizeBytes)) {
    return DEFAULT_STREAM_CHUNK_BYTES;
  }
  const normalized = Math.floor(chunkSizeBytes);
  if (normalized < MIN_STREAM_CHUNK_BYTES) {
    return MIN_STREAM_CHUNK_BYTES;
  }
  return normalized;
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

const savePathWithExtension = async (defaultPath: string | undefined, name: string, extension: string): Promise<SaveAsResult> => {
  const selected = await save({
    defaultPath: defaultPath || undefined,
    filters: [{ name, extensions: [extension] }]
  });
  if (!selected) return { kind: "cancelled" };
  const suffix = `.${extension}`;
  const lastDot = selected.lastIndexOf(".");
  const lastSeparator = Math.max(selected.lastIndexOf("/"), selected.lastIndexOf("\\"));
  if (lastDot < lastSeparator) return { kind: "saved", filePath: `${selected}${suffix}` };
  if (!selected.toLowerCase().endsWith(suffix)) throw new Error(`Choose a ${suffix} file`);
  return { kind: "saved", filePath: selected };
};

export const saveContainerPathAs = (defaultPath?: string) => savePathWithExtension(defaultPath, "Transcript container", "tsf");
export const saveTextExportPathAs = (defaultPath?: string) => savePathWithExtension(defaultPath, "Plain text", "txt");

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
  const chunkSizeBytes = normalizeChunkSizeBytes(options?.chunkSizeBytes);
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
