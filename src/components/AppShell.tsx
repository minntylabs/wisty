import { Show } from "solid-js";
import { AboutDialog } from "./AboutDialog";
import { AddedWordsDialog } from "./AddedWordsDialog";
import { ConfirmDiscardModal } from "./ConfirmDiscardModal";
import { ErrorModal } from "./ErrorModal";
import { ExternalChangeBanner, type ExternalChangeBannerKind } from "./ExternalChangeBanner";
import { FileLoadingModal } from "./FileLoadingModal";
import { FileSavingModal } from "./FileSavingModal";
import { LargeFileOpenModal } from "./LargeFileOpenModal";
import { ImportProblemsModal } from "./ImportProblemsModal";
import { AudioConversionModal } from "./AudioConversionModal";
import { MenuBar } from "./MenuBar";
import type { ErrorModalEntry } from "../core/app/useErrorModalQueue";
import type { CursorPositionPayload } from "../core/editor/editorAdapter";

type AppShellProps = {
  setEditorHostRef: (node: HTMLDivElement) => void;
  safeModeActive: boolean;
  aboutOpen: boolean;
  appVersion: string;
  confirmDiscardOpen: boolean;
  onConfirmDiscardCancel: () => void;
  onConfirmDiscard: () => void;
  onAboutClose: () => void;
  onAboutError: (payload: {
    title: string;
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  }) => void;
  addedWordsDialog: {
    open: boolean;
    words: string[];
    onClose: () => void;
    onRemove: (word: string) => void;
  };
  largeFileDialog: {
    open: boolean;
    kind: "confirm" | "blocked";
    filePath: string;
    sizeBytes: number;
    onCancel: () => void;
    onOpenAnyway: () => void;
    onAcknowledge: () => void;
  };
  importProblems: {
    open: boolean;
    problems: string[];
    cueCount: number;
    onCancel: () => void;
    onImportAnyway: () => void;
  };
  audioConversion: {
    open: boolean;
    lines: string[];
    /** ffmpeg's readings, each `null` until it has reported one. */
    durationSecs: number | null;
    positionSecs: number | null;
    onCancel: () => void;
  };
  showTransferHitBlocker: boolean;
  loading: {
    overlayOpen: boolean;
    filePath: string;
    bytesRead: number;
    totalBytes?: number;
    largeLineSafeMode: boolean;
    onCancel: () => void;
  };
  saving: {
    overlayOpen: boolean;
    filePath: string;
    charsWritten: number;
    totalChars?: number;
    onCancel: () => void;
  };
  statusBar: {
    enabled: boolean;
    formatViewMode: "formatted" | "plain";
    /**
     * The whole document's count, which arrives after typing stops. `null`
     * until the document open now has been counted — never the last one's.
     */
    words: number | null;
  } & CursorPositionPayload;
  errorModal: {
    open: boolean;
    entry: ErrorModalEntry | null;
    onDismiss: () => void;
  };
  externalChange: {
    visible: boolean;
    kind: ExternalChangeBannerKind | undefined;
    filePath: string;
    busy: boolean;
    onReload: () => void;
    onSaveAs: () => void;
    onOverwrite: () => void;
    onDismiss: () => void;
  };
};

export const AppShell = (props: AppShellProps) => {
  return (
    <main class="app-shell">
      <MenuBar />

      <section class="editor-shell">
        <div ref={props.setEditorHostRef} class="editor-host" />
      </section>

      <Show when={props.safeModeActive}>
        <div class="large-line-safe-banner">Opened in large-line safe mode for stability.</div>
      </Show>

      <ExternalChangeBanner {...props.externalChange} />

      <Show when={props.statusBar.enabled}>
        <div class="status-bar">
          <span>
            Line {props.statusBar.currentLine.toLocaleString()} of {props.statusBar.totalLines.toLocaleString()}
          </span>
          <span class="status-bar-character">
            Character {props.statusBar.currentCharacter.toLocaleString()} of {props.statusBar.totalCharacters.toLocaleString()}
          </span>
          <span class="status-bar-words">
            {props.statusBar.words === null
              ? "counting\u2026"
              : `${props.statusBar.words.toLocaleString()} ${props.statusBar.words === 1 ? "word" : "words"}`}
          </span>
          <span class="status-bar-mode">
            {props.statusBar.formatViewMode === "formatted" ? "Formatted view" : "Plain text view"}
          </span>
        </div>
      </Show>

      <ConfirmDiscardModal
        open={props.confirmDiscardOpen}
        onCancel={props.onConfirmDiscardCancel}
        onDiscard={props.onConfirmDiscard}
      />

      <AboutDialog
        open={props.aboutOpen}
        version={props.appVersion}
        onClose={props.onAboutClose}
        onError={props.onAboutError}
      />

      <AddedWordsDialog
        open={props.addedWordsDialog.open}
        words={props.addedWordsDialog.words}
        onClose={props.addedWordsDialog.onClose}
        onRemove={props.addedWordsDialog.onRemove}
      />

      <LargeFileOpenModal
        open={props.largeFileDialog.open}
        kind={props.largeFileDialog.kind}
        filePath={props.largeFileDialog.filePath}
        sizeBytes={props.largeFileDialog.sizeBytes}
        onCancel={props.largeFileDialog.onCancel}
        onOpenAnyway={props.largeFileDialog.onOpenAnyway}
        onAcknowledge={props.largeFileDialog.onAcknowledge}
      />

      <ImportProblemsModal
        open={props.importProblems.open}
        problems={props.importProblems.problems}
        cueCount={props.importProblems.cueCount}
        onCancel={props.importProblems.onCancel}
        onImportAnyway={props.importProblems.onImportAnyway}
      />

      <AudioConversionModal
        open={props.audioConversion.open}
        lines={props.audioConversion.lines}
        durationSecs={props.audioConversion.durationSecs}
        positionSecs={props.audioConversion.positionSecs}
        onCancel={props.audioConversion.onCancel}
      />

      <Show when={props.showTransferHitBlocker}>
        <div class="file-loading-hit-blocker" aria-hidden="true" />
      </Show>

      <FileLoadingModal
        open={props.loading.overlayOpen}
        filePath={props.loading.filePath}
        bytesRead={props.loading.bytesRead}
        totalBytes={props.loading.totalBytes}
        largeLineSafeMode={props.loading.largeLineSafeMode}
        onCancel={props.loading.onCancel}
      />

      <FileSavingModal
        open={props.saving.overlayOpen}
        filePath={props.saving.filePath}
        charsWritten={props.saving.charsWritten}
        totalChars={props.saving.totalChars}
        onCancel={props.saving.onCancel}
      />

      <ErrorModal
        open={props.errorModal.open}
        entry={props.errorModal.entry}
        onDismiss={props.errorModal.onDismiss}
      />
    </main>
  );
};
