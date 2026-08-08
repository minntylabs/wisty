import type {
  DocumentPort,
  EditorPort,
  ErrorReporter,
  ExpectedSaveSource,
  FileDialogsPort,
  FileIoPort,
  FontPickerPort,
  SettingsPort,
  TextSnapshot,
  TextFileVersion
} from "./contracts";
import { createSignal } from "solid-js";
import type { LaunchFileStreamChunkResult } from "../window/launchArgService";
import { toAppError, type AppErrorCode } from "../errors/appError";
import { stripMarkers } from "../tsf/markers";

type UseFileLifecycleDeps = {
  editor: Pick<EditorPort, "focus" | "getText" | "snapshotText" | "setText" | "append" | "reset" | "setLargeLineSafeMode" | "getRevision" | "setMarkersEnabled">;
  document: Pick<
    DocumentPort,
    "state" | "setRevision" | "markCleanAt" | "markSavedAt" | "markDirty" | "setFilePath" | "setUntitled"
  >;
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
    startSaveFileStream: (filePath: string, expectedSource?: ExpectedSaveSource) => Promise<{ streamId: string; filePath: string }>;
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

/**
 * How the file on disk disagrees with the document.
 *
 * `appeared` is the counterpart of `deleted` for a document being created: it
 * expected no file at its path, and something else put one there.
 */
type ExternalChangeKind = "changed" | "deleted" | "appeared";

type ExternalChange = {
  filePath: string;
  kind: ExternalChangeKind;
};

/**
 * What the document is measured against.
 *
 * `absent` is a baseline in its own right, not the lack of one: a document
 * created at an empty path asserts that the path is still empty when it saves.
 * Only `null` means nothing is known, and then a save asserts nothing.
 */
type TextFileBaseline =
  | { kind: "present"; version: TextFileVersion }
  | { kind: "absent" };

const sameTextFileVersion = (left: TextFileVersion, right: TextFileVersion) =>
  left.size === right.size
  && left.modifiedMs === right.modifiedMs
  && left.device === right.device
  && left.inode === right.inode;

/**
 * Which conflict, if any, the backend refused a save over.
 *
 * By code rather than by message: the wording lives in Rust, and matching it
 * from here would silently degrade every conflict into a generic save failure
 * the next time someone reworded it.
 */
const externalChangeKindFromSaveError = (error: unknown): ExternalChangeKind | null => {
  switch (toAppError(error, "SAVE_FAILED", "Unable to save file").code) {
    case "SAVE_EXTERNAL_CHANGE":
      return "changed";
    case "SAVE_EXTERNAL_DELETE":
      return "deleted";
    case "SAVE_EXTERNAL_APPEARED":
      return "appeared";
    default:
      return null;
  }
};

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
  const [externalChange, setExternalChange] = createSignal<ExternalChange | null>(null);
  const [externalChangeDismissed, setExternalChangeDismissed] = createSignal(false);

  let activeLoadId = 0;
  let loadingOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSaveId = 0;
  let savingOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  let textFileBaseline: TextFileBaseline | null = null;
  let textFileBaselineGeneration = 0;
  let observedExternalVersion: TextFileVersion | null = null;
  let textFileBaselineError: Error | null = null;

  const clearTextFileBaseline = () => {
    textFileBaselineGeneration += 1;
    textFileBaseline = null;
    observedExternalVersion = null;
    textFileBaselineError = null;
    setExternalChange(null);
    setExternalChangeDismissed(false);
  };

  /**
   * Raises a conflict, recording the on-disk version it was raised for.
   *
   * That version is what a dismissal is a dismissal *of*: without it the next
   * check has nothing to recognise and raises the same conflict again.
   */
  const raiseExternalChange = (
    filePath: string,
    kind: ExternalChangeKind,
    observed: TextFileVersion | null = null
  ) => {
    observedExternalVersion = observed;
    if (kind === "deleted") {
      // The editor now holds the only copy of this text. Saying so keeps the
      // close prompt in the way of losing it, whether or not it was edited.
      deps.document.markDirty();
    }
    setExternalChange({ filePath, kind });
    setExternalChangeDismissed(false);
  };

  /** Drops a conflict whose difference no longer exists. */
  const retractExternalChange = () => {
    if (!externalChange()) {
      return;
    }
    observedExternalVersion = null;
    setExternalChange(null);
    setExternalChangeDismissed(false);
  };

  /**
   * Records what is on disk at `filePath` as what this document is measured
   * against.
   *
   * Never throws. A baseline is taken around operations that have already
   * succeeded, so a failure here says nothing about whether they did and must
   * not be reported as though it did. It is recorded instead, and Save is what
   * acts on it — the one operation the missing baseline would endanger.
   *
   * `missingIsExpected` separates the two reasons a path can hold no file: a
   * document being created there, and a file that has gone since Wisty last
   * looked. The second is a deletion the user has to be told about, and saying
   * nothing would let a save recreate it silently.
   */
  const captureTextFileBaseline = async (
    filePath: string,
    options?: { missingIsExpected?: boolean }
  ) => {
    textFileBaselineGeneration += 1;
    observedExternalVersion = null;
    setExternalChange(null);
    setExternalChangeDismissed(false);
    try {
      const version = await deps.fileIo.getTextFileVersion(filePath);
      textFileBaselineError = null;
      textFileBaseline = version ? { kind: "present", version } : { kind: "absent" };
      if (!version && !options?.missingIsExpected) {
        raiseExternalChange(filePath, "deleted");
      }
    } catch (error) {
      textFileBaseline = null;
      textFileBaselineError = new Error(
        `Wisty cannot check this file on disk: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  /** What a save asserts about the target, or nothing when no baseline is held. */
  const expectedSaveSource = (): ExpectedSaveSource | undefined => {
    if (!textFileBaseline) {
      return undefined;
    }
    return textFileBaseline.kind === "present"
      ? { kind: "present", version: textFileBaseline.version }
      : { kind: "absent" };
  };

  /**
   * Whether the document a save started from is still the open one. Opening a
   * file does not cancel a save already streaming, so what a save learned about
   * its own document — its saved revision, its baseline — must not be written
   * over a different document that arrived while it ran.
   */
  const documentStillOpenAt = (filePath: string) =>
    deps.document.state.kind === "text" && deps.document.state.filePath === filePath;

  const checkForExternalChange = async (): Promise<boolean> => {
    if (deps.document.state.kind !== "text" || !deps.document.state.filePath || !textFileBaseline) {
      return false;
    }
    const filePath = deps.document.state.filePath;
    const baseline = textFileBaseline;
    const generation = textFileBaselineGeneration;
    const current = await deps.fileIo.getTextFileVersion(filePath);
    if (
      generation !== textFileBaselineGeneration
      || deps.document.state.kind !== "text"
      || deps.document.state.filePath !== filePath
      || textFileBaseline !== baseline
    ) {
      return false;
    }

    if (!current) {
      if (baseline.kind === "absent") {
        // Still empty, which is what a document being created here expects.
        retractExternalChange();
        return false;
      }
      if (externalChange()?.kind !== "deleted") {
        // Raised with no observed version: what comes back after a deletion is
        // judged on its own, and a dismissal of what was there before the file
        // went away is not consent to what replaces it.
        raiseExternalChange(filePath, "deleted");
      }
      return true;
    }

    const differs = baseline.kind === "absent" || !sameTextFileVersion(baseline.version, current);
    if (differs) {
      if (!observedExternalVersion || !sameTextFileVersion(observedExternalVersion, current)) {
        raiseExternalChange(filePath, baseline.kind === "absent" ? "appeared" : "changed", current);
      }
      return true;
    }
    // Back to the version this document was opened at — the conflict the banner
    // reported no longer exists, so retract it rather than leave it standing.
    retractExternalChange();
    return false;
  };

  /**
   * Raises a conflict the backend caught in the moment between the last check
   * and the rename, reading the version that beat it so the banner behaves like
   * any other — dismissible, and retracted if the file comes back.
   */
  const raiseExternalChangeFromSaveRace = async (filePath: string, kind: ExternalChangeKind) => {
    let observed: TextFileVersion | null = null;
    if (kind !== "deleted") {
      try {
        observed = await deps.fileIo.getTextFileVersion(filePath);
      } catch {
        // Best effort: without it the next check raises the conflict again,
        // which is the safe direction to fail in.
      }
    }
    raiseExternalChange(filePath, kind, observed);
  };

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
    clearTextFileBaseline();
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
    // `openContainer` reads and validates before Rust replaces its current
    // container. Do that before changing the frontend, so a bad replacement
    // leaves the open transcript usable instead of showing it without audio or
    // marker support.
    const container = await deps.fileIo.openContainer(filePath);
    clearTextFileBaseline();
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

  type FileSizeVerdict = { kind: "within-limits"; fileSize: number } | { kind: "refused" };

  /**
   * The soft prompt and the hard refusal, in one place so that every path that
   * reads a file whole is subject to them — reloading a file that changed on
   * disk included, which is the one case where its size is known to have moved.
   */
  const checkFileSizeLimits = async (filePath: string): Promise<FileSizeVerdict> => {
    const fileSize = await deps.fileIo.getFileSize(filePath);
    if (fileSize >= HARD_FILE_LIMIT_BYTES) {
      await deps.showFileTooLarge(filePath, fileSize);
      return { kind: "refused" };
    }
    if (fileSize >= SOFT_FILE_LIMIT_BYTES && !await deps.confirmOpenLargeFile(filePath, fileSize)) {
      return { kind: "refused" };
    }
    return { kind: "within-limits", fileSize };
  };

  /**
   * Reads a text file into the editor as the open document, with its baseline.
   *
   * The baseline is taken *before* the read, not after. These reads stream, and
   * a large one takes long enough for a writer to land inside it: measuring
   * afterwards would record the file as it became, call the half-and-half text
   * in the editor a faithful copy of it, and let the next save write that back
   * with nothing to notice. Taken beforehand, a change during the read is a
   * conflict like any other, which the check afterwards raises.
   *
   * A failed read leaves the document untitled, so the baseline goes with it:
   * a banner offering to overwrite a path this document no longer has is worse
   * than no banner at all.
   */
  const loadTextDocumentWithBaseline = async (filePath: string, load: () => Promise<void>) => {
    // A file that is not there is this open's own failure to report, not a
    // deletion to raise a banner over: the read is about to say so.
    await captureTextFileBaseline(filePath, { missingIsExpected: true });
    try {
      await load();
    } catch (error) {
      clearTextFileBaseline();
      throw error;
    }
    deps.document.setFilePath(filePath);
    try {
      await checkForExternalChange();
    } catch {
      // Reading metadata can fail; Save is where that matters and says so.
    }
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

      const size = await checkFileSizeLimits(selected.filePath);
      if (size.kind === "refused") {
        deps.editor.focus();
        return;
      }

      // The container goes here rather than at the branch above, so backing
      // out of a large-file prompt leaves the open transcript untouched.
      await releaseContainer();
      await loadTextDocumentWithBaseline(
        selected.filePath,
        () => loadEditorFileAsCleanFromFsStream(selected.filePath, size.fileSize)
      );
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
        await loadTextDocumentWithBaseline(
          filePath,
          () => loadEditorFileAsCleanFromFsStream(filePath)
        );
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
      await loadTextDocumentWithBaseline(
        filePath,
        () => loadEditorFileAsCleanFromLaunchStream(filePath, fileSizeBytes)
      );
      await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
      await deps.settings.actions.addRecentFile(filePath);
      deps.rememberedPosition.restore(filePath);
      deps.editor.focus();
    }, "Unable to open launch file");
  };

  const openFileFromTextAtPath = async (filePath: string, text: string) => {
    await releaseContainer();
    clearTextFileBaseline();
    const useLargeLineSafeMode = text.length >= SAFE_MODE_PROBE_BYTES && !text.includes("\n");
    applySafeMode(useLargeLineSafeMode);
    loadEditorTextAsClean(text);
    deps.document.setFilePath(filePath);
    // The text did not come from disk, so whether the path holds a file is not
    // known here and its absence is no deletion. A baseline is taken all the
    // same: it is what stops a later save writing over whatever is there.
    await captureTextFileBaseline(filePath, { missingIsExpected: true });
    await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
    deps.rememberedPosition.restore(filePath);
    deps.editor.focus();
  };

  const openMissingFileAtPath = async (filePath: string) => {
    // Only reachable from the launch argument today, where nothing can be open
    // yet — but this is a public method, and every other entry point releases.
    // Being the one exception is how the openFile bug survived.
    await releaseContainer();
    clearTextFileBaseline();
    applySafeMode(false);
    loadEditorTextAsClean("");
    deps.document.setFilePath(filePath);
    // An empty path is this document's baseline, not the lack of one: the file
    // it is about to create is not there yet, and a save has to say so rather
    // than write over whatever arrives at that path in the meantime.
    await captureTextFileBaseline(filePath, { missingIsExpected: true });
    await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
    deps.editor.focus();
  };

  /**
   * Writes the document to `filePath` in chunks, returning the editor revision
   * that was written.
   *
   * The text is snapshotted before the first chunk rather than sliced from the
   * live editor. Chunks are separated by awaits on the backend, so the user can
   * type throughout: reading the editor as it is now would shift every later
   * slice and write a file that matches no version of the document. The
   * returned revision is what the caller marks saved — it is the one on disk,
   * which is not necessarily the one in the editor by the time this resolves.
   */
  const saveDocumentToPathViaStream = async (
    filePath: string,
    text?: string,
    expectedSource?: ExpectedSaveSource
  ): Promise<number> => {
    const source: TextSnapshot =
      text === undefined
        ? deps.editor.snapshotText()
        : { length: text.length, revision: deps.editor.getRevision(), slice: (from, to) => text.slice(from, to) };
    const totalChars = source.length;
    const saveId = beginSavingState(filePath, totalChars);
    let streamId: string | undefined;
    let finished = false;
    let charsWritten = 0;

    try {
      const started = expectedSource
        ? await deps.saveFileStream.startSaveFileStream(filePath, expectedSource)
        : await deps.saveFileStream.startSaveFileStream(filePath);
      streamId = started.streamId;

      let from = 0;
      while (from < totalChars) {
        if (activeSaveId !== saveId || saveCancelRequested()) {
          throw new FileSaveCancelledError();
        }

        let to = Math.min(totalChars, from + SAVE_STREAM_CHUNK_CHARS);
        if (to < totalChars) {
          const charBefore = source.slice(to - 1, to);
          const charCode = charBefore.charCodeAt(0);
          if (charCode >= 0xd800 && charCode <= 0xdbff) {
            to -= 1;
          }
        }
        if (to <= from) {
          to = Math.min(totalChars, from + 1);
        }

        const chunk = source.slice(from, to);
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
      return source.revision;
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
   * History updates that follow a completed write.
   *
   * By the time these run the bytes are on disk, so a settings failure must not
   * surface as "Unable to save file" — the file did save. Directory and recent
   * file history are conveniences, and losing one is not worth telling the user
   * their save failed.
   */
  const rememberLastDirectory = async (filePath: string) => {
    try {
      await deps.settings.actions.setLastDirectory(deps.fileIo.getDirectoryFromFilePath(filePath));
    } catch {
      // Best effort: see above.
    }
  };

  const rememberRecentFile = async (filePath: string) => {
    try {
      await deps.settings.actions.addRecentFile(filePath);
    } catch {
      // Best effort: see rememberLastDirectory.
    }
  };

  const saveContainerAtPath = async (filePath: string) => {
    if (isSaving()) {
      return;
    }
    const transcript = deps.editor.getText();
    const revision = deps.editor.getRevision();
    const saveId = beginSavingState(filePath, transcript.length);
    try {
      await deps.fileIo.saveContainer(filePath, transcript);
      setSavingCharsWritten(transcript.length);
      deps.document.markSavedAt(revision);
      deps.document.setFilePath(filePath, "container");
      await rememberLastDirectory(filePath);
      deps.editor.focus();
    } finally {
      endSavingState(saveId);
    }
  };

  const saveFileAs = async () => {
    if (deps.document.state.kind === "container") {
      await runWithErrorMessage(async () => {
        const result = await deps.fileDialogs.saveContainerPathAs(deps.document.state.filePath);
        if (result.kind === "cancelled") {
          deps.editor.focus();
          return;
        }
        const previousPath = deps.document.state.filePath;
        await saveContainerAtPath(result.filePath);
        await deps.rememberedPosition.migrate(previousPath, result.filePath);
        await rememberRecentFile(result.filePath);
      }, "Unable to save file");
      return;
    }
    await runWithErrorMessage(async () => {
      const result = await deps.fileDialogs.saveTextFilePathAs(deps.settings.state.lastDirectory);
      if (result.kind === "cancelled") {
        deps.editor.focus();
        return;
      }

      const previousPath = deps.document.state.filePath;
      const savedRevision = await saveDocumentToPathViaStream(result.filePath);
      if (!documentStillOpenAt(previousPath)) {
        return;
      }
      await deps.rememberedPosition.migrate(previousPath, result.filePath);
      deps.document.setFilePath(result.filePath);
      deps.document.markSavedAt(savedRevision);
      await captureTextFileBaseline(result.filePath);
      await rememberLastDirectory(result.filePath);
      await rememberRecentFile(result.filePath);
      deps.editor.focus();
    }, "Unable to save file");
  };

  const saveFile = async () => {
    if (deps.document.state.kind === "container") {
      await runWithErrorMessage(() => saveContainerAtPath(deps.document.state.filePath), "Unable to save file");
      return;
    }
    if (!deps.document.state.filePath) {
      await saveFileAs();
      return;
    }

    const filePath = deps.document.state.filePath;
    await runWithErrorMessage(async () => {
      if (textFileBaselineError) {
        // Try once more before refusing: a baseline that could not be taken
        // leaves nothing to validate this save against, but one unlucky moment
        // should not lock the document until it is closed and reopened.
        await captureTextFileBaseline(filePath);
        if (textFileBaselineError) {
          throw textFileBaselineError;
        }
      }
      // The retake raises a conflict of its own when the file has gone in the
      // meantime, and that is not something to save straight over.
      if (await checkForExternalChange() || externalChange()) {
        setExternalChangeDismissed(false);
        return;
      }
      let savedRevision: number;
      try {
        savedRevision = await saveDocumentToPathViaStream(filePath, undefined, expectedSaveSource());
      } catch (error) {
        const kind = externalChangeKindFromSaveError(error);
        if (kind) {
          await raiseExternalChangeFromSaveRace(filePath, kind);
          return;
        }
        throw error;
      }
      if (!documentStillOpenAt(filePath)) {
        return;
      }
      deps.document.markSavedAt(savedRevision);
      await captureTextFileBaseline(filePath);
      await rememberLastDirectory(filePath);
      deps.editor.focus();
    }, "Unable to save file");
  };

  const exportText = async () => {
    if (deps.document.state.kind !== "container") {
      return;
    }
    await runWithErrorMessage(async () => {
      const result = await deps.fileDialogs.saveTextExportPathAs(deps.settings.state.lastDirectory);
      if (result.kind === "cancelled") {
        deps.editor.focus();
        return;
      }
      await saveDocumentToPathViaStream(result.filePath, stripMarkers(deps.editor.getText()));
      await rememberLastDirectory(result.filePath);
      deps.editor.focus();
    }, "Unable to export text");
  };

  const reloadExternalChange = async () => {
    const change = externalChange();
    if (!change || change.kind === "deleted") {
      return;
    }
    await runWithErrorMessage(async () => {
      // The file on disk is by definition not the one whose size was checked
      // when this document was opened, so it goes through the limits again.
      const size = await checkFileSizeLimits(change.filePath);
      if (size.kind === "refused") {
        deps.editor.focus();
        return;
      }
      await loadTextDocumentWithBaseline(
        change.filePath,
        () => loadEditorFileAsCleanFromFsStream(change.filePath, size.fileSize)
      );
      deps.rememberedPosition.restore(change.filePath);
      deps.editor.focus();
    }, "Unable to reload file");
  };

  const overwriteExternalChange = async () => {
    const change = externalChange();
    if (!change) {
      return;
    }
    await runWithErrorMessage(async () => {
      // Deliberately unguarded: this is the user answering the conflict, and
      // the version they are overwriting is the one they were shown.
      const savedRevision = await saveDocumentToPathViaStream(change.filePath);
      if (!documentStillOpenAt(change.filePath)) {
        return;
      }
      deps.document.markSavedAt(savedRevision);
      await captureTextFileBaseline(change.filePath);
      await rememberLastDirectory(change.filePath);
      deps.editor.focus();
    }, "Unable to save file");
  };

  const dismissExternalChange = () => {
    setExternalChangeDismissed(true);
    deps.editor.focus();
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
    exportText,
    chooseEditorFont,
    requestCancelLoading,
    requestCancelSaving,
    checkForExternalChange,
    reloadExternalChange,
    overwriteExternalChange,
    dismissExternalChange,
    externalChangeState: {
      change: externalChange,
      isVisible: () => externalChange() !== null && !externalChangeDismissed()
    },
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
