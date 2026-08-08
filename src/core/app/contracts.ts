import type { Accessor } from "solid-js";
import type { FontStyle, FormatViewMode } from "../settings/settingsTypes";
import type { DocumentKind } from "../document/documentStore";

export type AsyncAction = () => Promise<void>;

export type CloseFlowState = "idle" | "awaiting-discard" | "force-closing";

export type CloseRequestEvent = {
  preventDefault: () => void;
};

export type ErrorReporter = {
  showError: (context: string, error: unknown) => Promise<void>;
};

export type OpenTextFileResult =
  | { kind: "cancelled" }
  | { kind: "opened"; filePath: string; text: string };

export type OpenTextFilePathResult =
  | { kind: "cancelled" }
  | { kind: "opened"; filePath: string };

export type SaveTextFileAsResult =
  | { kind: "cancelled" }
  | { kind: "saved"; filePath: string };

export type TextStreamChunk = {
  text: string;
  bytesReadTotal: number;
  fileSizeBytes?: number;
};

export type StreamReadTextFileOptions = {
  chunkSizeBytes?: number;
};

/** Metadata used to notice a text file replaced or edited outside Wisty. */
export type TextFileVersion = {
  size: number;
  modifiedMs: number | null;
  device: number | null;
  inode: number | null;
};

export type FileLoadPhase = "idle" | "loading" | "cancelling" | "error";

export type FileLoadProgress = {
  elapsedMs: number;
  bytesRead: number;
  totalBytes?: number;
};

export type LaunchFileStreamStartResult = {
  streamId: string;
  filePath: string;
  fileSizeBytes: number;
};

export type LaunchFileStreamChunkResult =
  | { kind: "chunk"; text: string; bytesReadTotal: number; fileSizeBytes: number }
  | { kind: "eof"; bytesReadTotal: number; fileSizeBytes: number };

export type LaunchFileStreamPort = {
  startLaunchFileStream: (filePath: string) => Promise<LaunchFileStreamStartResult>;
  readLaunchFileChunk: (streamId: string, maxBytes: number) => Promise<LaunchFileStreamChunkResult>;
  cancelLaunchFileStream: (streamId: string) => Promise<void>;
  closeLaunchFileStream: (streamId: string) => Promise<void>;
};

export type FileDialogsPort = {
  openTextFile: (defaultPath?: string) => Promise<OpenTextFileResult>;
  openTextFilePath: (defaultPath?: string) => Promise<OpenTextFilePathResult>;
  saveTextFilePathAs: (defaultPath?: string) => Promise<SaveTextFileAsResult>;
  saveContainerPathAs: (defaultPath?: string) => Promise<SaveTextFileAsResult>;
  saveTextExportPathAs: (defaultPath?: string) => Promise<SaveTextFileAsResult>;
};

export type FileIoPort = {
  getFileSize: (filePath: string) => Promise<number>;
  getTextFileVersion: (filePath: string) => Promise<TextFileVersion | null>;
  fileExists: (filePath: string) => Promise<boolean>;
  readTextFile: (filePath: string) => Promise<string>;
  streamReadTextFile: (
    filePath: string,
    options?: StreamReadTextFileOptions
  ) => AsyncGenerator<TextStreamChunk, void, void>;
  saveTextFile: (filePath: string, text: string) => Promise<void>;
  getDirectoryFromFilePath: (filePath: string) => string;
  isContainerPath: (filePath: string) => boolean;
  openContainer: (filePath: string) => Promise<OpenContainerResult>;
  closeContainer: () => Promise<void>;
  saveContainer: (filePath: string, transcript: string) => Promise<void>;
};

export type AppendTextOptions = {
  emitChange?: boolean;
  addToHistory?: boolean;
};

export type ResetEditorOptions = {
  emitChange?: boolean;
  addToHistory?: boolean;
};

/**
 * The document as it was at one instant, readable in pieces.
 *
 * A streamed save slices the document across many awaits, so reading the live
 * editor would let an edit made mid-save shift the text under the writer and
 * tear the file. A snapshot reads what was there when the save began, and
 * carries the revision it belongs to so the caller can tell whether the
 * document has moved on since.
 */
export type TextSnapshot = {
  length: number;
  revision: number;
  slice: (from: number, to: number) => string;
};

export type EditorPort = {
  focus: () => void;
  getText: () => string;
  snapshotText: () => TextSnapshot;
  getRevision: () => number;
  setText: (text: string, options?: { emitChange?: boolean }) => void;
  append: (text: string, options?: AppendTextOptions) => void;
  reset: (options?: ResetEditorOptions) => void;
  setLargeLineSafeMode: (enabled: boolean) => void;
  setFormatMode: (mode: FormatViewMode) => void;
  setMarkersEnabled: (enabled: boolean) => void;
  setMarkersVisible: (visible: boolean) => void;
  getFormatMode: () => FormatViewMode;
  toggleBold: () => void;
  toggleItalic: () => void;
  applyHeadingLevel: (level: number) => void;
  undoEdit: () => boolean;
  redoEdit: () => boolean;
  cutSelection: () => Promise<boolean>;
  copySelection: () => Promise<boolean>;
  pasteSelection: () => Promise<boolean>;
  openOrFocusFindPanel: () => boolean;
  openOrFocusReplacePanel: () => boolean;
  setHost: (node: HTMLDivElement) => void;
  init: () => void;
  destroy: () => void;
  applySettings: () => void;
};

export type DocumentPort = {
  state: {
    filePath: string;
    fileName: string;
    kind: DocumentKind;
    isDirty: boolean;
  };
  setRevision: (revision: number) => void;
  markCleanAt: (revision: number) => void;
  markSavedAt: (revision: number) => void;
  markDirty: () => void;
  setFilePath: (filePath: string, kind?: DocumentKind) => void;
  setUntitled: () => void;
};

export type OpenContainerResult = {
  transcript: string;
  meta: Record<string, unknown>;
  audioBytes: number;
};

export type FontSelection = {
  fontFamily: string;
  fontSize: number;
  fontStyle: FontStyle;
  fontWeight: number;
};

export type FontPickerPort = {
  chooseEditorFont: (current: FontSelection) => Promise<FontSelection | null>;
};

export type SettingsPort = {
  state: {
    themeMode: "light" | "dark";
    fontFamily: string;
    fontSize: number;
    fontStyle: FontStyle;
    fontWeight: number;
    textWrapEnabled: boolean;
    activeLineHighlightEnabled: boolean;
    formatViewMode: FormatViewMode;
    statusBarEnabled: boolean;
    lastDirectory: string;
    recentFiles: string[];
  };
  ready: Accessor<boolean>;
  load: () => Promise<void>;
  actions: {
    setThemeMode: (mode: "light" | "dark") => Promise<void>;
    setFontFamily: (fontFamily: string) => Promise<void>;
    setFontSize: (fontSize: number) => Promise<void>;
    setFontStyle: (fontStyle: FontStyle) => Promise<void>;
    setFontWeight: (fontWeight: number) => Promise<void>;
    setTextWrapEnabled: (enabled: boolean) => Promise<void>;
    setActiveLineHighlightEnabled: (enabled: boolean) => Promise<void>;
    setFormatViewMode: (mode: FormatViewMode) => Promise<void>;
    setStatusBarEnabled: (enabled: boolean) => Promise<void>;
    setLastDirectory: (path: string) => Promise<void>;
    addRecentFile: (filePath: string) => Promise<void>;
    setRecentFiles: (filePaths: string[]) => Promise<void>;
    removeRecentFile: (filePath: string) => Promise<void>;
  };
};
