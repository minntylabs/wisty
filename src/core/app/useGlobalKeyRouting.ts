import type { Accessor } from "solid-js";

type UseGlobalKeyRoutingOptions = {
  fileLoading: Accessor<boolean>;
  requestCancelFileLoad: () => void;
  fileSaving: Accessor<boolean>;
  requestCancelFileSave: () => void;
  errorModalOpen: Accessor<boolean>;
  dismissErrorModal: () => void;
  aboutOpen: Accessor<boolean>;
  addedWordsOpen: Accessor<boolean>;
  largeFileDialogOpen: Accessor<boolean>;
  confirmDiscardOpen: Accessor<boolean>;
  resolveConfirmDiscard: (shouldDiscard: boolean) => Promise<void>;
  menuPanelOpen: Accessor<boolean>;
  activeMenuId: Accessor<string | null>;
  closeMenu: () => void;
  openMenuByMnemonic: (key: string) => boolean;
  dispatchShortcut: (event: KeyboardEvent) => boolean;
  executeCommand: (id: string) => Promise<boolean>;
  focusEditor: () => void;
};

export const useGlobalKeyRouting = (options: UseGlobalKeyRoutingOptions) => {
  const handleGlobalKeydown = (event: KeyboardEvent) => {
    if (options.errorModalOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        options.dismissErrorModal();
      }
      return;
    }

    if (options.fileLoading()) {
      if (event.key === "Escape") {
        event.preventDefault();
        options.requestCancelFileLoad();
        return;
      }
      event.preventDefault();
      return;
    }

    if (options.fileSaving()) {
      if (event.key === "Escape") {
        event.preventDefault();
        options.requestCancelFileSave();
        return;
      }
      event.preventDefault();
      return;
    }

    // Dialogs handle their own keys (Escape via the dialog library); keep
    // application shortcuts from acting behind them.
    if (options.aboutOpen() || options.addedWordsOpen() || options.largeFileDialogOpen()) {
      return;
    }

    if (options.confirmDiscardOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        void options.resolveConfirmDiscard(false);
      }
      return;
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (options.openMenuByMnemonic(event.key)) {
        event.preventDefault();
        return;
      }
    }

    if (options.menuPanelOpen()) {
      const matched = options.dispatchShortcut(event);
      if (matched) {
        options.closeMenu();
        return;
      }
      if (options.activeMenuId() === "file" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        const recentIds: Record<string, string> = { "1": "file.recent.1", "2": "file.recent.2", "3": "file.recent.3" };
        const commandId = recentIds[event.key];
        if (commandId) {
          event.preventDefault();
          void options.executeCommand(commandId).then((executed) => {
            if (executed) {
              options.closeMenu();
              requestAnimationFrame(() => options.focusEditor());
            }
          });
        }
      }
      return;
    }

    options.dispatchShortcut(event);
  };

  return {
    handleGlobalKeydown
  };
};
