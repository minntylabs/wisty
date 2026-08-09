import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { AppShell } from "./components/AppShell";
import { createCommandRegistry } from "./core/commands/commandRegistry";
import { buildCommands, spellLanguageCommandId } from "./core/commands/buildCommands";
import type { DictionaryInfo } from "./core/spellcheck/spellService";
import { createShortcutRouter } from "./core/commands/shortcutRouter";
import type { ErrorReporter } from "./core/app/contracts";
import { CommandsProvider, MenuProvider } from "./core/app/appContexts";
import { useAppLifecycle } from "./core/app/useAppLifecycle";
import { useCloseFlow } from "./core/app/useCloseFlow";
import { useEditorSettingsSync } from "./core/app/useEditorSettingsSync";
import { createCoalescingTrigger } from "./core/app/coalescingTrigger";
import { useFileLifecycle } from "./core/app/useFileLifecycle";
import { useGlobalKeyRouting } from "./core/app/useGlobalKeyRouting";
import type { ConversionOutput } from "./core/tsf/conversionWatch";
import { createFakeConversion, type FakeConversion } from "./dev/fakeConversion";
import { useMenuCommandPipeline } from "./core/app/useMenuCommandPipeline";
import { useMenuState } from "./core/app/useMenuState";
import { useRememberedPosition } from "./core/app/useRememberedPosition";
import { useWindowTitleSync } from "./core/app/useWindowTitleSync";
import { useErrorModalQueue } from "./core/app/useErrorModalQueue";
import { createDocumentStore } from "./core/document/documentStore";
import { createEditorAdapter, type CursorPositionPayload } from "./core/editor/editorAdapter";
import { createPlaybackService } from "./core/audio/playbackService";
import { tauriPlaybackPort } from "./core/audio/playbackPort";
import {
  closeContainer,
  createContainer,
  fileExists,
  getDirectoryFromFilePath,
  getFileSize,
  getTextFilePresence,
  isContainerPath,
  openAudioFilePath,
  openContainer,
  openSubtitleFilePath,
  openTextFile,
  openTextFilePath,
  probeAudioFile,
  readTextFileAtPath,
  takeConversionOutput,
  cancelAudioConversion,
  saveContainer,
  saveContainerPathAs,
  saveTextFile,
  saveTextExportPathAs,
  saveTextFilePathAs,
  streamReadTextFileAtPath
} from "./core/files/fileService";
import { describeCueProblems } from "./core/tsf/cueProblems";
import type { CueProblem } from "./core/tsf/vtt";
import { createSettingsStore } from "./core/settings/settingsStore";
import { chooseEditorFont } from "./core/fonts/fontDialog";
import { toAppError } from "./core/errors/appError";
import {
  cancelSaveFileStream,
  finishSaveFileStream,
  startSaveFileStream,
  writeSaveFileChunk
} from "./core/window/saveStreamService";
import {
  cancelLaunchFileStream,
  closeLaunchFileStream,
  readLaunchFileChunk,
  startLaunchFileStream,
  takeLaunchFileArg,
  type LaunchFileArg
} from "./core/window/launchArgService";

const MAIN_WINDOW_LABEL = "main";
const PLATFORM_IS_MAC = navigator.userAgent.toLowerCase().includes("mac");

type LargeFileDialogState =
  | {
      kind: "confirm";
      filePath: string;
      sizeBytes: number;
      resolve: (value: boolean) => void;
    }
  | {
      kind: "blocked";
      filePath: string;
      sizeBytes: number;
      resolve: () => void;
    };

/** An import waiting on an answer about cues that do not fit the recording. */
type ImportProblemsState = {
  lines: string[];
  cueCount: number;
  resolve: (accepted: boolean) => void;
};

function App() {
  const appWindow = getCurrentWindow();
  const documentStore = createDocumentStore();
  const settingsStore = createSettingsStore();
  const menuState = useMenuState();
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [addedWordsOpen, setAddedWordsOpen] = createSignal(false);
  const [addedWords, setAddedWords] = createSignal<string[]>([]);
  const [appVersion, setAppVersion] = createSignal("2.0.1");
  const [largeFileDialog, setLargeFileDialog] = createSignal<LargeFileDialogState | null>(null);
  const [importProblems, setImportProblems] = createSignal<ImportProblemsState | null>(null);
  const [cursorPosition, setCursorPosition] = createSignal<CursorPositionPayload>({
    currentLine: 1,
    totalLines: 1,
    // An empty document: no characters, and none behind the caret.
    currentCharacter: 0,
    totalCharacters: 0
  });
  const [wordCount, setWordCount] = createSignal<number | null>(null);
  const [spellDictionaries, setSpellDictionaries] = createSignal<DictionaryInfo[]>([]);
  // Deliberately not persisted: transcript mode is a per-session tidying tool,
  // and its clicks are destructive enough that it should never be on at startup.
  const [transcriptModeEnabled, setTranscriptModeEnabled] = createSignal(false);
  const errorModalQueue = useErrorModalQueue();

  let editorHostRef: HTMLDivElement | undefined;

  const errors: ErrorReporter = {
    showError: async (context, error) => {
      const appError = toAppError(error, "UNKNOWN", context, { context });
      errorModalQueue.enqueue({
        title: context,
        message: appError.message,
        code: appError.code,
        details: appError.details
      });
    }
  };


  /**
   * Errors are reported rather than swallowed: a click that makes no sound is
   * indistinguishable from a broken feature, and the likely causes — no output
   * device, a damaged recording — are things the user can act on.
   */
  const playback = createPlaybackService(tauriPlaybackPort, (error) => {
    void errors.showError("Unable to play audio", error);
  });

  const editorAdapter = createEditorAdapter({
    getSettings: () => settingsStore.state,
    onMarkerClick: playback.playMarker,
    onStopPlayback: playback.stop,
    onDocChanged: ({ revision }) => {
      documentStore.setRevision(revision);
    },
    onCursorPositionChanged: setCursorPosition,
    onWordCountChanged: setWordCount,
    onFormatModeChanged: (mode) => {
      void settingsStore.actions.setFormatViewMode(mode);
    },
    onViewPositionChanged: () => {
      rememberedPosition.scheduleCapture();
    }
  });

  const rememberedPosition = useRememberedPosition({
    editor: editorAdapter,
    document: documentStore,
    settings: settingsStore
  });

  const closeLargeFileDialog = () => {
    setLargeFileDialog(null);
    editorAdapter.focus();
  };

  const confirmOpenLargeFile = (filePath: string, sizeBytes: number): Promise<boolean> =>
    new Promise((resolve) => {
      setLargeFileDialog({
        kind: "confirm",
        filePath,
        sizeBytes,
        resolve
      });
    });

  const showFileTooLarge = (filePath: string, sizeBytes: number): Promise<void> =>
    new Promise((resolve) => {
      setLargeFileDialog({
        kind: "blocked",
        filePath,
        sizeBytes,
        resolve
      });
    });

  /**
   * The conversion is showing while it has said anything and has not finished.
   * ffmpeg is talkative from its first moment, so this appears immediately for
   * a recording that needs converting and never for one that does not.
   */
  const [conversionLines, setConversionLines] = createSignal<string[]>([]);
  const [converting, setConverting] = createSignal(false);
  /** ffmpeg's two readings: the recording's length, and how far into it it is. */
  const [conversionDuration, setConversionDuration] = createSignal<number | null>(null);
  const [conversionPosition, setConversionPosition] = createSignal<number | null>(null);

  /**
   * The conversion probe, which exists only in a development build.
   *
   * Alt+Shift+P opens the window on a conversion that never finishes, so it
   * can be watched for as long as it takes: a real import gives about fifteen
   * seconds, after three file dialogs. The props shape is switchable because
   * that is the thing under suspicion — see `dev/conversionProbe`.
   */
  const [probePropShape, setProbePropShape] = createSignal<"eager" | "lazy">("lazy");
  let fakeConversion: FakeConversion | null = null;

  const receiveConversionOutput = (output: ConversionOutput) => {
    setConverting(true);
    if (output.lines.length > 0) {
      setConversionLines((seen) => [...seen, ...output.lines]);
    }
    if (output.durationSecs !== null) {
      setConversionDuration(output.durationSecs);
    }
    if (output.positionSecs !== null) {
      setConversionPosition(output.positionSecs);
    }
  };

  const finishConversion = () => {
    setConverting(false);
    setConversionLines([]);
    setConversionDuration(null);
    setConversionPosition(null);
  };

  if (import.meta.env.DEV) {
    onMount(() => {
      const startProbe = (event: KeyboardEvent) => {
        if (!event.altKey || !event.shiftKey || event.key.toLowerCase() !== "p" || fakeConversion) {
          return;
        }
        event.preventDefault();
        fakeConversion = createFakeConversion({
          onOutput: receiveConversionOutput,
          onFinished: () => {
            fakeConversion = null;
            finishConversion();
          }
        });
      };
      window.addEventListener("keydown", startProbe);
      onCleanup(() => window.removeEventListener("keydown", startProbe));
    });
  }

  /**
   * One object, made once. Rebuilding it per read would give `Show` a new value
   * every batch, which would re-create the probe — and the native `<details>`
   * it watches — on the very cadence the probe is there to observe.
   */
  const conversionProbeControls = import.meta.env.DEV
    ? {
        get propShape() {
          return probePropShape();
        },
        onPropShapeChange: setProbePropShape
      }
    : undefined;

  const cancelConversion = () => {
    if (fakeConversion) {
      fakeConversion.stop();
      return;
    }
    void cancelAudioConversion();
  };

  /**
   * The window's props, read one field at a time. Written plainly the whole
   * object is rebuilt on any access, so asking whether the window is open also
   * reads the output, and everything watching `open` wakes every time ffmpeg
   * says another word.
   *
   * A development build can switch to that plain shape from inside the window,
   * because it is what the probe is there to compare against.
   */
  const buildAudioConversionProps = () => {
    if (import.meta.env.DEV && probePropShape() === "eager") {
      return {
        open: converting(),
        lines: conversionLines(),
        durationSecs: conversionDuration(),
        positionSecs: conversionPosition(),
        onCancel: cancelConversion,
        probe: conversionProbeControls
      };
    }

    return {
      get open() {
        return converting();
      },
      get lines() {
        return conversionLines();
      },
      get durationSecs() {
        return conversionDuration();
      },
      get positionSecs() {
        return conversionPosition();
      },
      onCancel: cancelConversion,
      probe: conversionProbeControls
    };
  };

  const confirmImportProblems = (problems: CueProblem[], cueCount: number): Promise<boolean> =>
    new Promise((resolve) => {
      setImportProblems({ lines: describeCueProblems(problems), cueCount, resolve });
    });

  const closeImportProblems = (accepted: boolean) => {
    const pending = importProblems();
    setImportProblems(null);
    pending?.resolve(accepted);
    editorAdapter.focus();
  };

  const fileLifecycle = useFileLifecycle({
    editor: editorAdapter,
    document: documentStore,
    settings: settingsStore,
    rememberedPosition,
    fileDialogs: {
      openTextFile,
      openTextFilePath,
      openSubtitleFilePath,
      openAudioFilePath,
      saveTextFilePathAs,
      saveContainerPathAs,
      saveTextExportPathAs
    },
    fileIo: {
      getFileSize,
      getTextFilePresence,
      fileExists,
      readTextFile: readTextFileAtPath,
      streamReadTextFile: streamReadTextFileAtPath,
      saveTextFile,
      getDirectoryFromFilePath,
      isContainerPath,
      openContainer,
      closeContainer,
      saveContainer,
      probeAudio: probeAudioFile,
      createContainer
    },
    playback: { release: playback.release },
    launchFileStream: {
      startLaunchFileStream,
      readLaunchFileChunk,
      cancelLaunchFileStream,
      closeLaunchFileStream
    },
    saveFileStream: {
      startSaveFileStream,
      writeSaveFileChunk,
      finishSaveFileStream,
      cancelSaveFileStream
    },
    fontPicker: {
      chooseEditorFont
    },
    errors,
    confirmOpenLargeFile,
    showFileTooLarge,
    confirmImportProblems,
    appVersion,
    conversion: {
      takeOutput: takeConversionOutput,
      // Each reading is kept until the next one that has it. The last look the
      // watch takes lands after the conversion has been cleared away, and
      // letting that empty it would blank the window on its way out.
      onOutput: receiveConversionOutput,
      onFinished: finishConversion
    }
  });

  const closeFlow = useCloseFlow({
    isDirty: () => documentStore.state.isDirty,
    closeWindow: () => appWindow.close(),
    focusEditor: () => editorAdapter.focus(),
    errors
  });

  onMount(() => {
    // Both triggers below can arrive for one activation, and a check can still
    // be running when the next activation arrives. Coalescing rather than
    // ignoring keeps the duplicate cheap without losing the one that came too
    // late to join the run in flight — which is the one after the window was
    // away long enough for the file to change.
    const checkForExternalChange = createCoalescingTrigger(() =>
      fileLifecycle.checkForExternalChange().catch(() => {
        // Save is where an unreadable file matters, and it says so there.
        // Returning to the window is not the moment to interrupt typing with it.
      })
    );

    // Two triggers, because neither covers the other. The DOM event does not
    // fire on window re-activation in every webview — WebKitGTK is the one this
    // project has already been bitten by — and the window event is Tauri's, so
    // it says nothing about focus moving within the page.
    window.addEventListener("focus", checkForExternalChange);
    // Handled here rather than at cleanup: a registration that fails before
    // then would otherwise go unhandled, and the DOM listener still stands.
    const unlistenFocus = appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        checkForExternalChange();
      }
    }).catch(() => null);
    onCleanup(() => {
      window.removeEventListener("focus", checkForExternalChange);
      void unlistenFocus.then((stopListening) => stopListening?.());
    });
  });

  const openAboutDialog = async () => {
    setAboutOpen(true);
  };

  const closeAboutDialog = () => {
    setAboutOpen(false);
    editorAdapter.focus();
  };

  const openAddedWordsDialog = async () => {
    try {
      setAddedWords(await editorAdapter.listAddedWords());
      setAddedWordsOpen(true);
    } catch (error) {
      const appError = toAppError(error, "UNKNOWN", "Unable to load added words");
      errorModalQueue.enqueue({
        title: "Unable to load added words",
        message: appError.message,
        code: appError.code,
        details: appError.details
      });
    }
  };

  const closeAddedWordsDialog = () => {
    setAddedWordsOpen(false);
    editorAdapter.focus();
  };

  const removeAddedWord = async (word: string) => {
    try {
      await editorAdapter.removeAddedWord(word);
      setAddedWords((current) => current.filter((existing) => existing !== word));
    } catch (error) {
      const appError = toAppError(error, "UNKNOWN", "Unable to remove word");
      errorModalQueue.enqueue({
        title: "Unable to remove word",
        message: appError.message,
        code: appError.code,
        details: appError.details
      });
    }
  };

  const dismissErrorModalAndRefocus = () => {
    const hadSingleEntry = errorModalQueue.entries().length <= 1;
    errorModalQueue.dismissCurrent();
    if (!hadSingleEntry) {
      return;
    }
    requestAnimationFrame(() => {
      editorAdapter.focus();
    });
  };

  const loadSettingsAndPruneRecentFiles = async () => {
    await settingsStore.load();
    const recentFiles = settingsStore.state.recentFiles;
    const existing = await Promise.all(recentFiles.map(async (filePath) => ({
      filePath,
      exists: await fileExists(filePath)
    })));
    const nextRecentFiles = existing.filter((entry) => entry.exists).map((entry) => entry.filePath);
    if (nextRecentFiles.length !== recentFiles.length) {
      await settingsStore.actions.setRecentFiles(nextRecentFiles);
    }
    await pruneRememberedPositions();
    await loadSpellDictionaries();
  };

  /** Drops remembered positions for files that no longer exist. */
  const pruneRememberedPositions = async () => {
    const entries = Object.entries(settingsStore.state.rememberedPositions);
    if (entries.length === 0) {
      return;
    }
    const surviving = await Promise.all(entries.map(async (entry) => (
      await fileExists(entry[0]) ? entry : null
    )));
    const next = surviving.filter((entry) => entry !== null);
    if (next.length !== entries.length) {
      await settingsStore.actions.setRememberedPositions(Object.fromEntries(next));
    }
  };

  const loadSpellDictionaries = async () => {
    const dictionaries = await editorAdapter.listSpellDictionaries();
    setSpellDictionaries(dictionaries);

    if (dictionaries.length === 0) {
      if (settingsStore.state.spellCheckEnabled) {
        await settingsStore.actions.setSpellCheckEnabled(false);
      }
      return;
    }
    if (!dictionaries.some((entry) => entry.code === settingsStore.state.spellCheckLanguage)) {
      await settingsStore.actions.setSpellCheckLanguage(dictionaries[0].code);
    }
  };

  const showSpellInstallHelp = () => {
    errorModalQueue.enqueue({
      title: "Spell Check",
      message:
        "Install hunspell dictionaries to /usr/share/hunspell. For example, "
        + "“sudo apt install hunspell-en-us” on Debian/Ubuntu, or “sudo dnf install hunspell-en-US” "
        + "on Fedora."
    });
  };

  const { definitions, sections } = buildCommands({
    platform: { isMac: PLATFORM_IS_MAC },
    closeFlow,
    fileLifecycle,
    editor: editorAdapter,
    settings: settingsStore,
    transcriptMode: {
      enabled: transcriptModeEnabled,
      setEnabled: setTranscriptModeEnabled
    },
    isContainerDocument: () => documentStore.state.kind === "container",
    rememberedPosition,
    spell: {
      dictionaries: spellDictionaries,
      showInstallHelp: showSpellInstallHelp,
      showAddedWords: () => void openAddedWordsDialog()
    },
    showAbout: openAboutDialog
  });

  const commandRegistry = createCommandRegistry(definitions);

  createEffect(() => {
    for (const dictionary of spellDictionaries()) {
      commandRegistry.register({
        id: spellLanguageCommandId(dictionary.code),
        label: dictionary.label,
        refocusEditorOnMenuSelect: true,
        checked: () =>
          settingsStore.state.spellCheckEnabled
          && settingsStore.state.spellCheckLanguage === dictionary.code,
        run: async () => {
          await settingsStore.actions.setSpellCheckLanguage(dictionary.code);
          await settingsStore.actions.setSpellCheckEnabled(true);
        }
      });
    }
  });
  const isInteractionBlocked = () =>
    fileLifecycle.loadingState.isLoading()
    || fileLifecycle.savingState.isSaving()
    || errorModalQueue.open()
    || aboutOpen()
    || addedWordsOpen()
    || largeFileDialog() !== null
    || closeFlow.confirmDiscardOpen();

  const { handleMenuCommandSelected, handleMenuPanelOpenChange } = useMenuCommandPipeline({
    menuPanelOpen: menuState.menuPanelOpen,
    setMenuPanelOpen: menuState.setMenuPanelOpen,
    setActiveMenuId: menuState.setActiveMenuId,
    commandRegistry,
    focusEditor: () => editorAdapter.focus(),
    isInteractionBlocked
  });

  const shortcutRouter = createShortcutRouter({
    definitions,
    canExecute: (commandId) => !isInteractionBlocked() && commandRegistry.canExecute(commandId),
    execute: (commandId) => {
      if (isInteractionBlocked()) {
        return Promise.resolve(false);
      }
      return commandRegistry.execute(commandId);
    }
  });

  const { handleGlobalKeydown } = useGlobalKeyRouting({
    fileLoading: fileLifecycle.loadingState.isLoading,
    requestCancelFileLoad: fileLifecycle.requestCancelLoading,
    fileSaving: fileLifecycle.savingState.isSaving,
    requestCancelFileSave: fileLifecycle.requestCancelSaving,
    errorModalOpen: errorModalQueue.open,
    dismissErrorModal: dismissErrorModalAndRefocus,
    aboutOpen,
    addedWordsOpen,
    largeFileDialogOpen: () => largeFileDialog() !== null,
    confirmDiscardOpen: closeFlow.confirmDiscardOpen,
    resolveConfirmDiscard: closeFlow.resolveConfirmDiscard,
    menuPanelOpen: menuState.menuPanelOpen,
    activeMenuId: menuState.activeMenuId,
    closeMenu: () => {
      menuState.setMenuPanelOpen(false);
      menuState.setActiveMenuId(null);
    },
    openMenuByMnemonic: menuState.openByMnemonic,
    dispatchShortcut: (event) => shortcutRouter.dispatch(event),
    executeCommand: (id) => commandRegistry.execute(id),
    focusEditor: () => editorAdapter.focus()
  });

  const commandsContextValue = {
    sections,
    registry: commandRegistry
  };

  const menuContextValue = {
    activeMenuId: menuState.activeMenuId,
    onActiveMenuIdChange: menuState.setActiveMenuId,
    menuPanelOpen: menuState.menuPanelOpen,
    onMenuPanelOpenChange: handleMenuPanelOpenChange,
    onMenuCommandSelected: handleMenuCommandSelected,
    onRequestEditorFocus: () => editorAdapter.focus()
  };

  useAppLifecycle({
    getEditorHost: () => editorHostRef,
    editor: editorAdapter,
    document: documentStore,
    loadSettings: loadSettingsAndPruneRecentFiles,
    onSettingsLoadError: async (error) => {
      const appError = toAppError(error, "SETTINGS_LOAD_FAILED", "Unable to load settings");
      errorModalQueue.enqueue({
        title: "Unable to load settings",
        message: appError.message,
        code: appError.code,
        details: appError.details
      });
    },
    takeLaunchFileArg,
    openLaunchFileArg: async (launchFile: LaunchFileArg) => {
      if (launchFile.exists) {
        await fileLifecycle.openLaunchFileAtPath(launchFile.path, launchFile.fileSizeBytes);
        return;
      }
      await fileLifecycle.openMissingFileAtPath(launchFile.path);
    },
    onLaunchFileOpenError: async (error) => {
      const appError = toAppError(error, "LAUNCH_OPEN_FAILED", "Unable to open launch file");
      errorModalQueue.enqueue({
        title: "Unable to open launch file",
        message: appError.message,
        code: appError.code,
        details: appError.details
      });
    },
    loadVersion: () => getVersion(),
    setAppVersion,
    handleGlobalKeydown,
    registerCloseRequested: (handler) => appWindow.onCloseRequested(handler),
    handleWindowCloseRequested: closeFlow.handleWindowCloseRequested
  });

  useEditorSettingsSync({
    settings: settingsStore,
    editor: editorAdapter,
    applyTheme: (mode) => {
      document.documentElement.dataset.theme = mode;
    }
  });

  useWindowTitleSync({
    fileName: () => documentStore.state.fileName,
    isDirty: () => documentStore.state.isDirty,
    windowLabel: MAIN_WINDOW_LABEL
  });

  return (
    <CommandsProvider value={commandsContextValue}>
      <MenuProvider value={menuContextValue}>
        <AppShell
          setEditorHostRef={(node) => {
            editorHostRef = node;
          }}
          safeModeActive={fileLifecycle.safeModeActive()}
          aboutOpen={aboutOpen()}
          appVersion={appVersion()}
          confirmDiscardOpen={closeFlow.confirmDiscardOpen()}
          onConfirmDiscardCancel={() => void closeFlow.resolveConfirmDiscard(false)}
          onConfirmDiscard={() => void closeFlow.resolveConfirmDiscard(true)}
          onAboutClose={closeAboutDialog}
          onAboutError={(payload) => {
            errorModalQueue.enqueue(payload);
          }}
          addedWordsDialog={{
            open: addedWordsOpen(),
            words: addedWords(),
            onClose: closeAddedWordsDialog,
            onRemove: (word) => void removeAddedWord(word)
          }}
          largeFileDialog={{
            open: largeFileDialog() !== null,
            kind: largeFileDialog()?.kind ?? "confirm",
            filePath: largeFileDialog()?.filePath ?? "",
            sizeBytes: largeFileDialog()?.sizeBytes ?? 0,
            onCancel: () => {
              const state = largeFileDialog();
              if (state?.kind === "confirm") {
                state.resolve(false);
              }
              closeLargeFileDialog();
            },
            onOpenAnyway: () => {
              const state = largeFileDialog();
              if (state?.kind === "confirm") {
                state.resolve(true);
              }
              closeLargeFileDialog();
            },
            onAcknowledge: () => {
              const state = largeFileDialog();
              if (state?.kind === "blocked") {
                state.resolve();
              }
              closeLargeFileDialog();
            }
          }}
          audioConversion={buildAudioConversionProps()}
          importProblems={{
            open: importProblems() !== null,
            problems: importProblems()?.lines ?? [],
            cueCount: importProblems()?.cueCount ?? 0,
            onCancel: () => closeImportProblems(false),
            onImportAnyway: () => closeImportProblems(true)
          }}
          showTransferHitBlocker={
            (fileLifecycle.loadingState.isLoading() && !fileLifecycle.loadingState.showLoadingOverlay())
            || (fileLifecycle.savingState.isSaving() && !fileLifecycle.savingState.showSavingOverlay())
          }
          loading={{
            overlayOpen: fileLifecycle.loadingState.showLoadingOverlay(),
            filePath: fileLifecycle.loadingState.loadingFilePath(),
            bytesRead: fileLifecycle.loadingState.loadingBytesRead(),
            totalBytes: fileLifecycle.loadingState.loadingTotalBytes(),
            largeLineSafeMode: fileLifecycle.loadingState.loadingLargeLineSafeMode(),
            onCancel: fileLifecycle.requestCancelLoading
          }}
          saving={{
            overlayOpen: fileLifecycle.savingState.showSavingOverlay(),
            filePath: fileLifecycle.savingState.savingFilePath(),
            charsWritten: fileLifecycle.savingState.savingCharsWritten(),
            totalChars: fileLifecycle.savingState.savingTotalChars(),
            onCancel: fileLifecycle.requestCancelSaving
          }}
          statusBar={{
            enabled: settingsStore.state.statusBarEnabled,
            ...cursorPosition(),
            words: wordCount(),
            formatViewMode: settingsStore.state.formatViewMode
          }}
          errorModal={{
            open: errorModalQueue.open(),
            entry: errorModalQueue.current(),
            onDismiss: dismissErrorModalAndRefocus
          }}
          externalChange={{
            visible: fileLifecycle.externalChangeState.isVisible(),
            kind: fileLifecycle.externalChangeState.change()?.kind,
            filePath: fileLifecycle.externalChangeState.change()?.filePath ?? "",
            busy: isInteractionBlocked(),
            // The path is taken at the click, not when the reload runs: a dirty
            // document goes through the discard prompt first, and the conflict
            // can be retracted while it is open.
            onReload: () => {
              const filePath = fileLifecycle.externalChangeState.change()?.filePath;
              if (!filePath) {
                return;
              }
              void closeFlow.runOrConfirmDiscard(() => fileLifecycle.reloadExternalChange(filePath));
            },
            onSaveAs: () => void fileLifecycle.saveFileAs(),
            onOverwrite: () => void fileLifecycle.overwriteExternalChange(),
            onDismiss: fileLifecycle.dismissExternalChange
          }}
        />
      </MenuProvider>
    </CommandsProvider>
  );
}

export default App;
