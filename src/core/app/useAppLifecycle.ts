import { onCleanup, onMount } from "solid-js";
import type { CloseRequestEvent, DocumentPort, EditorPort } from "./contracts";
import type { LaunchFileArg } from "../window/launchArgService";

type UseAppLifecycleOptions = {
  getEditorHost: () => HTMLDivElement | undefined;
  editor: Pick<EditorPort, "setHost" | "init" | "setText" | "getRevision" | "focus" | "destroy" | "applySettings">;
  document: Pick<DocumentPort, "markCleanAt">;
  loadSettings: () => Promise<void>;
  onSettingsLoadError: (error: unknown) => Promise<void>;
  takeLaunchFileArg: () => Promise<LaunchFileArg | null>;
  openLaunchFileArg: (launchFile: LaunchFileArg) => Promise<void>;
  onLaunchFileOpenError: (error: unknown) => Promise<void>;
  loadVersion: () => Promise<string>;
  setAppVersion: (version: string) => void;
  handleGlobalKeydown: (event: KeyboardEvent) => void;
  registerCloseRequested: (
    handler: (event: CloseRequestEvent) => void
  ) => Promise<() => void>;
  handleWindowCloseRequested: (event: CloseRequestEvent) => void;
};

export const useAppLifecycle = (options: UseAppLifecycleOptions) => {
  let unlistenCloseRequest: (() => void) | undefined;
  let disposed = false;

  onMount(() => {
    const editorHost = options.getEditorHost();
    if (!editorHost) {
      return;
    }

    options.editor.setHost(editorHost);
    options.editor.init();
    options.editor.setText("", { emitChange: false });
    options.document.markCleanAt(options.editor.getRevision());
    options.editor.focus();

    window.addEventListener("keydown", options.handleGlobalKeydown);

    const settingsLoaded = options
      .loadSettings()
      .then(() => {
        options.editor.applySettings();
      })
      .catch(async (error) => {
        await options.onSettingsLoadError(error);
      });

    void options
      .loadVersion()
      .then((version) => {
        options.setAppVersion(version);
      })
      .catch(() => {
        // keep fallback version
      });

    // Open the launch file only after settings have loaded: opening updates
    // recent files and the last directory, and those writes are dropped (and
    // then clobbered) if the settings store isn't ready yet.
    void settingsLoaded
      .then(() => options.takeLaunchFileArg())
      .then(async (launchFile) => {
        if (!launchFile) {
          return;
        }
        try {
          await options.openLaunchFileArg(launchFile);
        } catch (error) {
          await options.onLaunchFileOpenError(error);
        }
      })
      .catch(() => {
        // ignore unavailable launch argument path
      });

    void options
      .registerCloseRequested((event) => {
        options.handleWindowCloseRequested(event);
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenCloseRequest = unlisten;
      });
  });

  onCleanup(() => {
    disposed = true;
    window.removeEventListener("keydown", options.handleGlobalKeydown);
    if (unlistenCloseRequest) {
      unlistenCloseRequest();
      unlistenCloseRequest = undefined;
    }
    options.editor.destroy();
  });
};
