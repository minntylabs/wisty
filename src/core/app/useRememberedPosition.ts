import { createMemo, onCleanup, type Accessor } from "solid-js";
import type { RememberedPosition } from "../settings/settingsTypes";

/**
 * Per-file scroll and caret memory, opted into through View > Remember Position.
 *
 * The stored entry *is* the opt-in: a file is restored on open precisely when it
 * has one, so there is no separate flag to keep in sync and nothing is restored
 * that the user did not ask for. Toggling off deletes the entry.
 */

/** Idle time before a scroll or caret move is written back to settings. */
const CAPTURE_DEBOUNCE_MS = 1000;

type UseRememberedPositionDeps = {
  editor: {
    getViewPosition: () => RememberedPosition | null;
    setViewPosition: (position: RememberedPosition) => void;
  };
  document: {
    state: { filePath: string };
  };
  settings: {
    state: { rememberedPositions: Record<string, RememberedPosition> };
    actions: {
      rememberPosition: (filePath: string, position: RememberedPosition) => Promise<void>;
      forgetPosition: (filePath: string) => Promise<void>;
      moveRememberedPosition: (fromPath: string, toPath: string) => Promise<void>;
    };
  };
};

export const useRememberedPosition = (deps: UseRememberedPositionDeps) => {
  let captureTimer: ReturnType<typeof setTimeout> | undefined;

  const filePath = createMemo(() => deps.document.state.filePath);
  const canRemember = createMemo(() => filePath().length > 0);
  const isRemembered = createMemo(() => filePath() in deps.settings.state.rememberedPositions);

  const cancelPendingCapture = () => {
    if (captureTimer !== undefined) {
      clearTimeout(captureTimer);
      captureTimer = undefined;
    }
  };

  /** Writes the current position back, but only for a file already opted in. */
  const capture = async () => {
    cancelPendingCapture();
    const path = filePath();
    if (!path || !isRemembered()) {
      return;
    }
    const position = deps.editor.getViewPosition();
    if (position) {
      await deps.settings.actions.rememberPosition(path, position);
    }
  };

  /**
   * Debounced so a continuous scroll writes once when it settles rather than per
   * frame. Persisting on every settle (instead of only on close) means a crash
   * or a kill costs at most the last second of movement.
   */
  const scheduleCapture = () => {
    if (!isRemembered()) {
      return;
    }
    cancelPendingCapture();
    captureTimer = setTimeout(() => {
      captureTimer = undefined;
      void capture();
    }, CAPTURE_DEBOUNCE_MS);
  };

  const toggle = async () => {
    const path = filePath();
    if (!path) {
      return;
    }
    if (isRemembered()) {
      cancelPendingCapture();
      await deps.settings.actions.forgetPosition(path);
      return;
    }
    // Store straight away rather than waiting for the next scroll, so the menu
    // check is truthful the moment it is ticked.
    const position = deps.editor.getViewPosition();
    if (position) {
      await deps.settings.actions.rememberPosition(path, position);
    }
  };

  /** Applied as the last step of opening a file, once its text is fully loaded. */
  const restore = (path: string) => {
    const position = deps.settings.state.rememberedPositions[path];
    if (position) {
      deps.editor.setViewPosition(position);
    }
  };

  /** Keeps the entry with the document when Save As gives it a new path. */
  const migrate = async (fromPath: string, toPath: string) => {
    await deps.settings.actions.moveRememberedPosition(fromPath, toPath);
  };

  onCleanup(cancelPendingCapture);

  return {
    canRemember: canRemember satisfies Accessor<boolean>,
    isRemembered: isRemembered satisfies Accessor<boolean>,
    toggle,
    capture,
    scheduleCapture,
    restore,
    migrate
  };
};

export type RememberedPositionController = ReturnType<typeof useRememberedPosition>;
