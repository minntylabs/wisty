import type {
  DocumentPort,
  EditorPort,
  ErrorReporter,
  FileDialogsPort,
  FileIoPort,
  FontPickerPort,
  SettingsPort
} from "./contracts";
import { createSignal } from "solid-js";
import type { LaunchFileStreamChunkResult } from "../window/launchArgService";
import { toAppError, type AppErrorCode } from "../errors/appError";

type UseFileLifecycleDeps = {
  editor: Pick<EditorPort, "focus" | "getText" | "getDocLength" | "getTextSlice" | "setText" | "append" | "reset" | "setLargeLineSafeMode" | "getRevision" | "setMarkersEnabled">;
  document: Pick<DocumentPort, "state" | "setRevision" | "markCleanAt" | "setFilePath" | "setUntitled">;
  settings: Pick<SettingsPort, "state" | "actions">;
  fileDialogs: FileDialogsPort;
  fileIo: FileIoPort;
  launchFileStream: {
    startLaunchFileStream: (filePath: string) => Promise<{ streamId: string; filePath: string; fileSizeBytes: number }>;
    readLaunchFileChunk: (streamId: string, maxBytes: number) => Promise<LaunchFileStreamChunkResult>;
    cancelLaunchFileStream: (streamId: string) => Promise<void>;
    closeLaunchFileStream: (streamId: string) => Promise<void>;
  };
  saveFileStream: {
    startSaveFileStream: (filePath: string) => Promise<{ streamId: string; filePath: string }>;
    writeSaveFileChunk: (streamId: string, textChunk: string) => Promise<{ bytesWrittenTotal: number }>;
    finishSaveFileStream: (streamId: string) => Promise<{ bytesWrittenTotal: number }>;
    cancelSaveFileStream: (streamId: string) => Promise<void>;
  };
  fontPicker: FontPickerPort;
  rememberedPosition: {
    capture: () => Promise<void>;
    restore: (filePath: string) => void;
    migrate: (fromPath: string, toPath: string) => Promise<void>;
  };
  errors: ErrorReporter;
  /**
   * Playback belongs to the document that owns the recording, so closing one
   * has to silence the other. Only the release is needed here — starting and
   * stopping a span is the editor's business, not the file lifecycle's.
   */
  playback: { release: () => void };
  confirmOpenLargeFile: (filePath: string, sizeBytes: number) => Promise<boolean>;
  showFileTooLarge: (filePath: string, sizeBytes: number) => Promise<void>;
};

const SOFT_FILE_LIMIT_BYTES = 50 * 1024 * 1024;
const HARD_FILE_LIMIT_BYTES = 1024 * 1024 * 1024;
const LOADING_OVERLAY_DELAY_MS = 500;
const BATCH_NORMAL_BYTES = 1024 * 1024;
const BATCH_SAFE_MODE_BYTES = 256 * 1024;
const SAFE_MODE_PROBE_BYTES = 8 * 1024 * 1024;
const LAUNCH_STREAM_READ_BYTES = 256 * 1024;
const SAVE_STREAM_CHUNK_CHARS = 256 * 1024;
const SAVING_OVERLAY_DELAY_MS = 500;

class FileLoadCancelledError extends Error {
  constructor() {
    super("File load cancelled");
    this.name = "FileLoadCancelledError";
  }
}

const isFileLoadCancelledError = (error: unknown): error is FileLoadCancelledError =>
  error instanceof FileLoadCancelledError;

class FileSaveCancelledError extends Error {
  constructor() {
    super("File save cancelled");
    this.name = "FileSaveCancelledError";
  }
}

const isFileSaveCancelledError = (error: unknown): error is FileSaveCancelledError =>
  error instanceof FileSaveCancelledError;

const waitForNextFrame = () => new Promise<void>((resolve) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => resolve());
    return;
  }
  setTimeout(() => resolve(), 0);
});

export const useFileLifecycle = (deps: UseFileLifecycleDeps) => {
  const [isLoading, setIsLoading] = createSignal(false);
  const [showLoadingOverlay, setShowLoadingOverlay] = createSignal(false);
  const [loadingFilePath, setLoadingFilePath] = createSignal("");
  const [loadingBytesRead, setLoadingBytesRead] = createSignal(0);
  const [loadingTotalBytes, setLoadingTotalBytes] = createSignal<number | undefined>(undefined);
  const [loadingLargeLineSafeMode, setLoadingLargeLineSafeMode] = createSignal(false);
  const [safeModeActive, setSafeModeActive] = createSignal(false);
  const [cancelRequested, setCancelRequested] = createSignal(false);
  const [isSaving, setIsSaving] = createSignal(false);
  const [showSavingOverlay, setShowSavingOverlay] = createSignal(false);
  const [savingFilePath, setSavingFilePath] = createSignal("");
  const [savingCharsWritten, setSavingCharsWritten] = createSignal(0);
  const [savingTotalChars, setSavingTotalChars] = createSignal<number | undefined>(undefined);
  const [saveCancelRequested, setSaveCancelRequested] = createSignal(false);

  let activeLoadId = 0;
  let loadingOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSaveId = 0;
  let savingOverlayTimer: ReturnType<typeof setTimeout> | null = null;

  const beginLoadingState = (filePath: string) => {
    activeLoadId += 1;
    const loadId = activeLoadId;
    setIsLoading(true);
    setShowLoadingOverlay(false);
    setLoadingFilePath(filePath);
    setLoadingBytesRead(0);
    setLoadingTotalBytes(undefined);
    setLoadingLargeLineSafeMode(false);
    setCancelRequested(false);
    if (loadingOverlayTimer !== null) {
      clearTimeout(loadingOverlayTimer);
      loadingOverlayTimer = null;
    }
    loadingOverlayTimer = setTimeout(() => {
      if (!isLoading() || activeLoadId !== loadId) {
        return;
      }
      setShowLoadingOverlay(true);
    }, LOADING_OVERLAY_DELAY_MS);
    return loadId;
  };

  const endLoadingState = (loadId: number) => {
    if (activeLoadId !== loadId) {
      return;
    }
    if (loadingOverlayTimer !== null) {
      clearTimeout(loadingOverlayTimer);
      loadingOverlayTimer = null;
    }
    setIsLoading(false);
    setShowLoadingOverlay(false);
    setLoadingFilePath("");
    setLoadingBytesRead(0);
    setLoadingTotalBytes(undefined);
    setLoadingLargeLineSafeMode(false);
    setCancelRequested(false);
  };

  const requestCancelLoading = () => {
    if (!isLoading()) {
      return;
    }
    setCancelRequested(true);
  };

  const beginSavingState = (filePath: string, totalChars: number) => {
    activeSaveId += 1;
    const saveId = activeSaveId;
    setIsSaving(true);
    setShowSavingOverlay(false);
    setSavingFilePath(filePath);
    setSavingCharsWritten(0);
    setSavingTotalChars(totalChars);
    setSaveCancelRequested(false);
    if (savingOverlayTimer !== null) {
      clearTimeout(savingOverlayTimer);
      savingOverlayTimer = null;
    }
    savingOverlayTimer = setTimeout(() => {
      if (!isSaving() || activeSaveId !== saveId) {
        return;
      }
      setShowSavingOverlay(true);
    }, SAVING_OVERLAY_DELAY_MS);
    return saveId;
  };

  const endSavingState = (saveId: number) => {
    if (activeSaveId !== saveId) {
      return;
    }
    if (savingOverlayTimer !== null) {
      clearTimeout(savingOverlayTimer);
      savingOverlayTimer = null;
    }
    setIsSaving(false);
    setShowSavingOverlay(false);
    setSavingFilePath("");
    setSavingCharsWritten(0);
    setSavingTotalChars(undefined);
    setSaveCancelRequested(false);
  };

  const requestCancelSaving = () => {
    if (!isSaving()) {
      return;
    }
    setSaveCancelRequested(true);
  };

  const applySafeMode = (enabled: boolean) => {
    setSafeModeActive(enabled);
    deps.editor.setLargeLineSafeMode(enabled);
  };

  const runWithErrorMessage = async (action: () => Promise<void>, context: string) => {
    const codeByContext = (): AppErrorCode => {
      const normalized = context.toLowerCase();
      if (normalized.includes("save")) {
        return "SAVE_FAILED";
      }
      if (normalized.includes("font")) {
        return "FONT_PICK_FAILED";
      }
      if (normalized.includes("launch")) {
        return "LAUNCH_OPEN_FAILED";
      }
      return "OPEN_FAILED";
    };

    try {
      await action();
    } catch (error) {
      if (isFileLoadCancelledError(error)) {
        deps.editor.focus();
        return;
      }
      if (isFileSaveCancelledError(error)) {
        deps.editor.focus();
        return;
      }
      await deps.errors.showError(
        context,
        toAppError(error, codeByContext(), context, { context })
      );
      deps.editor.focus();
    }
  };

  /**
   * Flushes the outgoing file's remembered position before the editor is reset.
   * Required for correctness, not just precision: a debounced capture still
   * pending when the path changes would otherwise write the old file's position
   * against the new file's key. Capture reads the path and position
   * synchronously, so this need not be awaited.
   */
  const flushOutgoingPosition = () => {
    void deps.rememberedPosition.capture();
  };

  const loadEditorTextAsClean = (text: string) => {
    flushOutgoingPosition();
    deps.editor.reset({ emitChange: false, addToHistory: false });
    if (text.length > 0) {
      deps.editor.append(text, { emitChange: false, addToHistory: false });
    }
    deps.document.markCleanAt(deps.editor.getRevision());
  };

  const loadEditorFileAsCleanFromChunkSource = async (
    filePath: string,
    chunks: AsyncIterable<{ text: string; bytesReadTotal: number; fileSizeBytes?: number }>,
    expectedTotalBytes?: number
  ) => {
    const loadId = beginLoadingState(filePath);
    let chunkIndex = 0;
    let pendingParts: string[] = [];
    let pendingBytes = 0;
    let targetBatchBytes = BATCH_NORMAL_BYTES;
    let sawNewlineInProbe = false;
    let safeModeEnabledForLoad = false;

    const enableLargeLineSafeMode = () => {
      if (safeModeEnabledForLoad) {
        return;
      }
      safeModeEnabledForLoad = true;
      targetBatchBytes = BATCH_SAFE_MODE_BYTES;
      applySafeMode(true);
      setLoadingLargeLineSafeMode(true);
    };

    const commitPendingBatch = async (reason: "threshold" | "final") => {
      if (pendingBytes <= 0) {
        return;
      }
      if (activeLoadId !== loadId || cancelRequested()) {
        throw new FileLoadCancelledError();
      }

      const batchText = pendingParts.join("");
      pendingParts = [];
      pendingBytes = 0;

      const startedAt = performance.now();
      try {
        deps.editor.append(batchText, { emitChange: false, addToHistory: false });
      } catch (error) {
        throw toAppError(
          error,
          "OPEN_FAILED",
          `Unable to append ${reason} batch at chunk ${chunkIndex}`,
          {
            filePath,
            reason,
            chunkIndex,
            batchChars: batchText.length
          }
        );
      }
      const commitDurationMs = performance.now() - startedAt;

      await waitForNextFrame();
      if (commitDurationMs > 24) {
        await waitForNextFrame();
      }
    };

    flushOutgoingPosition();
    deps.document.setUntitled();
    deps.document.markCleanAt(0);
    applySafeMode(false);
    if (typeof expectedTotalBytes === "number" && expectedTotalBytes > 0) {
      setLoadingTotalBytes(expectedTotalBytes);
    }
    deps.editor.reset({ emitChange: false, addToHistory: false });

    try {
      for await (const chunk of chunks) {
        if (activeLoadId !== loadId || cancelRequested()) {
          throw new FileLoadCancelledError();
        }

        chunkIndex += 1;

        setLoadingBytesRead(chunk.bytesReadTotal);
        if (typeof chunk.fileSizeBytes === "number") {
          setLoadingTotalBytes(chunk.fileSizeBytes);
        }

        if (!sawNewlineInProbe && chunk.text.includes("\n")) {
          sawNewlineInProbe = true;
        }
        if (!safeModeEnabledForLoad && !sawNewlineInProbe && chunk.bytesReadTotal >= SAFE_MODE_PROBE_BYTES) {
          enableLargeLineSafeMode();
        }

        if (typeof chunk.text !== "string") {
          throw toAppError(
            null,
            "OPEN_FAILED",
            `Invalid streamed chunk ${chunkIndex} at ${chunk.bytesReadTotal} bytes`,
            {
              filePath,
              chunkIndex,
              bytesReadTotal: chunk.bytesReadTotal,
              textType: typeof chunk.text
            }
          );
        }

        if (!chunk.text) {
          continue;
        }

        pendingParts.push(chunk.text);
        pendingBytes += chunk.text.length;

        if (pendingBytes >= targetBatchBytes) {
          await commitPendingBatch("threshold");
        }
      }

      if (activeLoadId !== loadId || cancelRequested()) {
        throw new FileLoadCancelledError();
      }

      await commitPendingBatch("final");
      deps.document.markCleanAt(deps.editor.getRevision());
      if (safeModeEnabledForLoad) {
        applySafeMode(true);
      } else {
        applySafeMode(false);
      }
    } catch (error) {
      deps.document.setUntitled();
      deps.document.setRevision(deps.editor.getRevision());
      if (safeModeEnabledForLoad) {
        applySafeMode(true);
      } else {
        applySafeMode(false);
      }
      if (isFileLoadCancelledError(error)) {
        throw error;
      }
      throw toAppError(error, "OPEN_FAILED", "Unable to open file", {
        filePath,
        chunkIndex
      });
    } finally {
      endLoadingState(loadId);
    }
  };

  const loadEditorFileAsCleanFromFsStream = async (filePath: string, expectedTotalBytes?: number) => {
    await loadEditorFileAsCleanFromChunkSource(
      filePath,
      deps.fileIo.streamReadTextFile(filePath),
      expectedTotalBytes
    );
  };

  const loadEditorFileAsCleanFromLaunchStream = async (filePath: string, expectedTotalBytes?: number) => {
    const stream = await deps.launchFileStream.startLaunchFileStream(filePath);
    let streamClosed = false;

    const closeStream = async () => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      await deps.launchFileStream.closeLaunchFileStream(stream.streamId);
    };

    const chunks = (async function* () {
      while (true) {
        if (cancelRequested()) {
          await deps.launchFileStream.cancelLaunchFileStream(stream.streamId);
          throw new FileLoadCancelledError();
        }

        const next = await deps.launchFileStream.readLaunchFileChunk(
          stream.streamId,
          LAUNCH_STREAM_READ_BYTES
        );

        if (next.kind === "eof") {
          break;
        }

        yield {
          text: next.text,
          bytesReadTotal: next.bytesReadTotal,
          fileSizeBytes: next.fileSizeBytes
        };
      }
    })();

    try {
      await loadEditorFileAsCleanFromChunkSource(filePath, chunks, expectedTotalBytes ?? stream.fileSizeBytes);
    } catch (error) {
      if (isFileLoadCancelledError(error)) {
        try {
          await deps.launchFileStream.cancelLaunchFileStream(stream.streamId);
        } catch {
          // ignore cancellation errors during teardown
        }
        throw error;
      }
      throw toAppError(error, "LAUNCH_OPEN_FAILED", "Unable to open launch file", {
        filePath
      });
    } finally {
      await closeStream();
    }
  };

  const newFile = async () => {
    await releaseContainer();
    applySafeMode(false);
    loadEditorTextAsClean("");
    deps.document.setUntitled();
    deps.editor.focus();
  };

  /**
   * Releases any container Rust is holding for the previous document.
   *
   * Called before loading anything else, so the recording does not stay
   * resident once the user has moved on. A failure here is deliberately
   * swallowed: it must never stop the file they asked for from opening.
   */
  const releaseContainer = async () => {
    // Marker handling goes with it. Every path that loads something other than
    // a container passes through here, so this is the one place the extension
    // is turned off, and a container turns it back on straight after.
    deps.editor.setMarkersEnabled(false);
    try {
      // Before the container goes, not after: audio still playing from a
      // transcript the user has closed is confusing, and the player reads the
      // very bytes the container is about to drop.
      //
      // It cannot throw — the service swallows its own failures rather than
      // raising a dialog about playback during a close nobody asked audio for —
      // so being inside this try buys nothing and is not what protects the
      // open. Left here only because it must run before closeContainer.
      deps.playback.release();
      await deps.fileIo.closeContainer();
    } catch {
      // Nothing the user can act on, and nothing that should block the open.
    }
  };

  /**
   * Opens a transcript container.
   *
   * Deliberately separate from the text path rather than generalised into it:
   * the two have nothing in common but a filename. In particular the size
   * probe and the streaming reader both read the file as text, which a zip is
   * not, so this must branch before either of them.
   */
  const openContainerAtPath = async (filePath: string) => {
    await releaseContainer();
    const container = await deps.fileIo.openContainer(filePath);
    applySafeMode(false);
    // Before the text, so the markers are tracked from the moment it lands
    // rather than being discovered by a later edit.
    deps.editor.setMarkersEnabled(true);
    loadEditorTextAsClean(container.transcript);
    deps.document.setFilePath(filePath, "container");
    await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
    await deps.settings.actions.addRecentFile(filePath);
    deps.rememberedPosition.restore(filePath);
    deps.editor.focus();
  };

  const openFile = async () => {
    await runWithErrorMessage(async () => {
      const selected = await deps.fileDialogs.openTextFilePath(deps.settings.state.lastDirectory);
      if (selected.kind === "cancelled") {
        deps.editor.focus();
        return;
      }

      if (deps.fileIo.isContainerPath(selected.filePath)) {
        await openContainerAtPath(selected.filePath);
        return;
      }

      const fileSize = await deps.fileIo.getFileSize(selected.filePath);
      if (fileSize >= HARD_FILE_LIMIT_BYTES) {
        await deps.showFileTooLarge(selected.filePath, fileSize);
        deps.editor.focus();
        return;
      }

      if (fileSize >= SOFT_FILE_LIMIT_BYTES) {
        const shouldOpen = await deps.confirmOpenLargeFile(selected.filePath, fileSize);
        if (!shouldOpen) {
          deps.editor.focus();
          return;
        }
      }

      await loadEditorFileAsCleanFromFsStream(selected.filePath, fileSize);
      deps.document.setFilePath(selected.filePath);
      await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(selected.filePath));
      await deps.settings.actions.addRecentFile(selected.filePath);
      deps.rememberedPosition.restore(selected.filePath);
      deps.editor.focus();
    }, "Unable to open file");
  };

  const openFileAtPath = async (filePath: string) => {
    await runWithErrorMessage(async () => {
      try {
        if (deps.fileIo.isContainerPath(filePath)) {
          await openContainerAtPath(filePath);
          return;
        }
        await releaseContainer();
        await loadEditorFileAsCleanFromFsStream(filePath);
        deps.document.setFilePath(filePath);
        await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
        await deps.settings.actions.addRecentFile(filePath);
        deps.rememberedPosition.restore(filePath);
        deps.editor.focus();
      } catch (error) {
        if (!await deps.fileIo.fileExists(filePath)) {
          await deps.settings.actions.removeRecentFile(filePath);
        }
        throw error;
      }
    }, "Unable to open file");
  };

  const openLaunchFileAtPath = async (filePath: string, fileSizeBytes?: number) => {
    await runWithErrorMessage(async () => {
      if (deps.fileIo.isContainerPath(filePath)) {
        await openContainerAtPath(filePath);
        return;
      }
      await releaseContainer();
      await loadEditorFileAsCleanFromLaunchStream(filePath, fileSizeBytes);
      deps.document.setFilePath(filePath);
      await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
      await deps.settings.actions.addRecentFile(filePath);
      deps.rememberedPosition.restore(filePath);
      deps.editor.focus();
    }, "Unable to open launch file");
  };

  const openFileFromTextAtPath = async (filePath: string, text: string) => {
    await releaseContainer();
    const useLargeLineSafeMode = text.length >= SAFE_MODE_PROBE_BYTES && !text.includes("\n");
    applySafeMode(useLargeLineSafeMode);
    loadEditorTextAsClean(text);
    deps.document.setFilePath(filePath);
    await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
    deps.rememberedPosition.restore(filePath);
    deps.editor.focus();
  };

  const openMissingFileAtPath = async (filePath: string) => {
    applySafeMode(false);
    loadEditorTextAsClean("");
    deps.document.setFilePath(filePath);
    await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
    deps.editor.focus();
  };

  const saveDocumentToPathViaStream = async (filePath: string) => {
    const totalChars = deps.editor.getDocLength();
    const saveId = beginSavingState(filePath, totalChars);
    let streamId: string | undefined;
    let finished = false;
    let charsWritten = 0;

    try {
      const started = await deps.saveFileStream.startSaveFileStream(filePath);
      streamId = started.streamId;

      let from = 0;
      while (from < totalChars) {
        if (activeSaveId !== saveId || saveCancelRequested()) {
          throw new FileSaveCancelledError();
        }

        let to = Math.min(totalChars, from + SAVE_STREAM_CHUNK_CHARS);
        if (to < totalChars) {
          const charBefore = deps.editor.getTextSlice(to - 1, to);
          const charCode = charBefore.charCodeAt(0);
          if (charCode >= 0xd800 && charCode <= 0xdbff) {
            to -= 1;
          }
        }
        if (to <= from) {
          to = Math.min(totalChars, from + 1);
        }

        const chunk = deps.editor.getTextSlice(from, to);
        if (!chunk) {
          from = to;
          continue;
        }
        await deps.saveFileStream.writeSaveFileChunk(streamId, chunk);
        charsWritten += chunk.length;
        setSavingCharsWritten(charsWritten);
        from = to;
      }

      if (activeSaveId !== saveId || saveCancelRequested()) {
        throw new FileSaveCancelledError();
      }

      await deps.saveFileStream.finishSaveFileStream(streamId);
      finished = true;
      setSavingCharsWritten(totalChars);
    } catch (error) {
      if (isFileSaveCancelledError(error)) {
        throw error;
      }
      throw toAppError(error, "SAVE_FAILED", "Unable to save file", {
        filePath,
        charsWritten,
        totalChars
      });
    } finally {
      if (!finished && streamId) {
        try {
          await deps.saveFileStream.cancelSaveFileStream(streamId);
        } catch {
          // ignore cancellation errors during save teardown
        }
      }
      endSavingState(saveId);
    }
  };

  /**
   * Saving a container is not implemented yet, and must not fall through to the
   * text path.
   *
   * That path streams the editor's text to the document's path, which for a
   * container would replace the archive — transcript, recording and metadata —
   * with plain text. The recording would be gone. Until saving repacks the
   * container properly, refusing is the only safe answer, and it has to be
   * refused rather than merely hidden from the menu: Ctrl+S does not consult
   * the menu.
   */
  const refuseContainerSave = async (): Promise<boolean> => {
    if (deps.document.state.kind !== "container") {
      return false;
    }
    await deps.errors.showError(
      "Unable to save file",
      toAppError(
        new Error(
          `${deps.document.state.fileName} holds its recording alongside the text, and saving it is not supported yet. Saving as plain text would discard the audio, so it has been refused.`
        ),
        "SAVE_FAILED",
        "Unable to save file",
        { context: "Unable to save file" }
      )
    );
    deps.editor.focus();
    return true;
  };

  const saveFileAs = async () => {
    if (await refuseContainerSave()) {
      return;
    }
    await runWithErrorMessage(async () => {
      const result = await deps.fileDialogs.saveTextFilePathAs(deps.settings.state.lastDirectory);
      if (result.kind === "cancelled") {
        deps.editor.focus();
        return;
      }

      const previousPath = deps.document.state.filePath;
      await saveDocumentToPathViaStream(result.filePath);
      await deps.rememberedPosition.migrate(previousPath, result.filePath);
      deps.document.setFilePath(result.filePath);
      deps.document.markCleanAt(deps.editor.getRevision());
      await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(result.filePath));
      await deps.settings.actions.addRecentFile(result.filePath);
      deps.editor.focus();
    }, "Unable to save file");
  };

  const saveFile = async () => {
    if (await refuseContainerSave()) {
      return;
    }
    if (!deps.document.state.filePath) {
      await saveFileAs();
      return;
    }

    await runWithErrorMessage(async () => {
      await saveDocumentToPathViaStream(deps.document.state.filePath);
      deps.document.markCleanAt(deps.editor.getRevision());
      await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(deps.document.state.filePath));
      deps.editor.focus();
    }, "Unable to save file");
  };

  const chooseEditorFont = async () => {
    await runWithErrorMessage(async () => {
      const selection = await deps.fontPicker.chooseEditorFont({
        fontFamily: deps.settings.state.fontFamily,
        fontSize: deps.settings.state.fontSize,
        fontStyle: deps.settings.state.fontStyle,
        fontWeight: deps.settings.state.fontWeight
      });

      if (!selection) {
        deps.editor.focus();
        return;
      }

      await deps.settings.actions.setFontFamily(selection.fontFamily);
      await deps.settings.actions.setFontSize(selection.fontSize);
      await deps.settings.actions.setFontStyle(selection.fontStyle);
      await deps.settings.actions.setFontWeight(selection.fontWeight);
      deps.editor.focus();
    }, "Unable to choose font");
  };

  return {
    newFile,
    openFile,
    openFileAtPath,
    openLaunchFileAtPath,
    openFileFromTextAtPath,
    openMissingFileAtPath,
    saveFile,
    saveFileAs,
    chooseEditorFont,
    requestCancelLoading,
    requestCancelSaving,
    loadingState: {
      isLoading,
      showLoadingOverlay,
      loadingFilePath,
      loadingBytesRead,
      loadingTotalBytes,
      loadingLargeLineSafeMode
    },
    savingState: {
      isSaving,
      showSavingOverlay,
      savingFilePath,
      savingCharsWritten,
      savingTotalChars
    },
    safeModeActive
  };
};
