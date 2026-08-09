import { createSignal, type Accessor } from "solid-js";
import type { AsyncAction, CloseFlowState, CloseRequestEvent, ErrorReporter } from "./contracts";

type UseCloseFlowDeps = {
  isDirty: Accessor<boolean>;
  closeWindow: () => Promise<void>;
  focusEditor: () => void;
  errors: ErrorReporter;
};

const ACTION_ERROR_CONTEXT = "Unable to complete action";

export const useCloseFlow = (deps: UseCloseFlowDeps) => {
  const [confirmDiscardOpen, setConfirmDiscardOpen] = createSignal(false);
  const [pendingAction, setPendingAction] = createSignal<AsyncAction | null>(null);
  const [closeFlowState, setCloseFlowState] = createSignal<CloseFlowState>("idle");

  const closeApplicationAction = async () => {
    setCloseFlowState("force-closing");
    try {
      await deps.closeWindow();
    } catch (error) {
      // The close did not happen, so the window is still here and still dirty.
      // Left at force-closing, the next close request would be read as one this
      // flow had already asked about and would go through without a prompt,
      // taking the unsaved work with it.
      setCloseFlowState("idle");
      throw error;
    }
  };

  const clearCloseIntent = () => {
    if (closeFlowState() === "awaiting-discard") {
      setCloseFlowState("idle");
    }
  };

  /**
   * Puts the discard question on screen for `action`, unless it is already on
   * screen for something else.
   *
   * The prompt names no action, so whichever one is pending is the one the
   * user's "discard" answers. Replacing it would run something they were never
   * asked about and drop what they were, without a trace. The menus are blocked
   * while the prompt is up, so this is hard to reach — but nothing enforces
   * that, and the window's close button is outside the menus entirely.
   *
   * Returns whether the question is now being asked about `action`.
   */
  const askToDiscard = (action: AsyncAction) => {
    if (confirmDiscardOpen()) {
      return false;
    }
    setPendingAction(() => action);
    setConfirmDiscardOpen(true);
    return true;
  };

  const runOrConfirmDiscard = async (action: AsyncAction) => {
    if (!deps.isDirty()) {
      await action();
      return;
    }
    askToDiscard(action);
  };

  const requestClose = async () => {
    if (!deps.isDirty()) {
      await closeApplicationAction();
      return;
    }
    if (askToDiscard(closeApplicationAction)) {
      setCloseFlowState("awaiting-discard");
    }
  };

  const resolveConfirmDiscard = async (shouldDiscard: boolean) => {
    setConfirmDiscardOpen(false);
    const action = pendingAction();
    setPendingAction(null);

    if (!action) {
      clearCloseIntent();
      deps.focusEditor();
      return;
    }

    if (!shouldDiscard) {
      clearCloseIntent();
      deps.focusEditor();
      return;
    }

    try {
      await action();
    } catch (error) {
      await deps.errors.showError(ACTION_ERROR_CONTEXT, error);
      deps.focusEditor();
    }
  };

  const handleWindowCloseRequested = (event: CloseRequestEvent) => {
    if (closeFlowState() === "force-closing") {
      setCloseFlowState("idle");
      return;
    }
    if (!deps.isDirty()) {
      return;
    }
    // Held back whether or not the question can be asked for this close: if a
    // prompt is already up for something else, letting the close through would
    // answer it by destroying the window.
    event.preventDefault();
    if (askToDiscard(closeApplicationAction)) {
      setCloseFlowState("awaiting-discard");
    }
  };

  return {
    closeFlowState,
    confirmDiscardOpen,
    runOrConfirmDiscard,
    requestClose,
    resolveConfirmDiscard,
    handleWindowCloseRequested
  };
};
