import { createEffect } from "solid-js";
import type { FormatViewMode } from "../settings/settingsTypes";

/**
 * Carries settings changes into the editor.
 *
 * This is wiring, but wiring with a trap in it: `applySettings` takes no
 * arguments and reads the settings itself, so the effect below has to *read*
 * each setting it should react to, whether or not it uses the value. A setting
 * left off that list is applied only when something else happens to change —
 * which is how showing the status bar once failed to reach the editor at all,
 * leaving the word count blank until the next keystroke.
 *
 * It lives here rather than in App.tsx so that the list is covered by tests: a
 * reading removed from it fails one.
 */

export type EditorSettingsSyncDeps = {
  settings: {
    state: {
      themeMode: "light" | "dark";
      fontFamily: string;
      fontSize: number;
      fontStyle: string;
      fontWeight: number;
      textWrapEnabled: boolean;
      activeLineHighlightEnabled: boolean;
      statusBarEnabled: boolean;
      formatViewMode: FormatViewMode;
      spellCheckEnabled: boolean;
      spellCheckLanguage: string;
    };
  };
  editor: {
    applySettings: () => void;
    setFormatMode: (mode: FormatViewMode) => void;
    configureSpellcheck: (options: { enabled: boolean; language: string }) => Promise<void> | void;
  };
  /** Where the theme lands. Injected so a test can see it without a DOM. */
  applyTheme: (mode: "light" | "dark") => void;
};

export const useEditorSettingsSync = (deps: EditorSettingsSyncDeps) => {
  createEffect(() => {
    const { state } = deps.settings;
    deps.applyTheme(state.themeMode);
    // Read for their dependencies, not their values: `applySettings` reads the
    // settings itself. Each of these is a setting the editor renders from, and
    // `statusBarEnabled` decides whether the document is worth counting words
    // in. Removing a reading here stops the editor hearing about that setting.
    void state.fontFamily;
    void state.fontSize;
    void state.fontStyle;
    void state.fontWeight;
    void state.textWrapEnabled;
    void state.activeLineHighlightEnabled;
    void state.statusBarEnabled;
    deps.editor.applySettings();
  });

  createEffect(() => {
    deps.editor.setFormatMode(deps.settings.state.formatViewMode);
  });

  createEffect(() => {
    void deps.editor.configureSpellcheck({
      enabled: deps.settings.state.spellCheckEnabled,
      language: deps.settings.state.spellCheckLanguage
    });
  });
};
