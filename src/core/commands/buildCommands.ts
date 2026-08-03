import type { CommandDefinition, MenuItem, MenuSection } from "./commandRegistry";
import type { Accessor } from "solid-js";
import type { DictionaryInfo } from "../spellcheck/spellService";
import type { FormatViewMode } from "../settings/settingsTypes";

/** Stable command id for selecting a given spell-check dictionary. */
export const spellLanguageCommandId = (code: string) => `view.spellCheck.lang.${code}`;

const fileNameFromPath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || filePath;
};

type BuildCommandsDeps = {
  platform: {
    isMac: boolean;
  };
  closeFlow: {
    runOrConfirmDiscard: (action: () => Promise<void>) => Promise<void>;
    requestClose: () => Promise<void>;
  };
  fileLifecycle: {
    newFile: () => Promise<void>;
    openFile: () => Promise<void>;
    openFileAtPath: (filePath: string) => Promise<void>;
    saveFile: () => Promise<void>;
    saveFileAs: () => Promise<void>;
    chooseEditorFont: () => Promise<void>;
    safeModeActive: Accessor<boolean>;
  };
  editor: {
    undoEdit: () => boolean;
    redoEdit: () => boolean;
    cutSelection: () => Promise<boolean>;
    copySelection: () => Promise<boolean>;
    pasteSelection: () => Promise<boolean>;
    openOrFocusFindPanel: () => boolean;
    openOrFocusReplacePanel: () => boolean;
    setFormatMode: (mode: FormatViewMode) => void;
    getFormatMode: () => FormatViewMode;
    toggleBold: () => void;
    toggleItalic: () => void;
    applyHeadingLevel: (level: number) => void;
    setTranscriptMode: (enabled: boolean) => void;
  };
  transcriptMode: {
    enabled: Accessor<boolean>;
    setEnabled: (enabled: boolean) => void;
  };
  settings: {
    state: {
      themeMode: "light" | "dark";
      textWrapEnabled: boolean;
      activeLineHighlightEnabled: boolean;
      formatViewMode: FormatViewMode;
      statusBarEnabled: boolean;
      spellCheckEnabled: boolean;
      spellCheckLanguage: string;
      recentFiles: string[];
    };
    actions: {
      setThemeMode: (mode: "light" | "dark") => Promise<void>;
      setTextWrapEnabled: (enabled: boolean) => Promise<void>;
      setActiveLineHighlightEnabled: (enabled: boolean) => Promise<void>;
      setStatusBarEnabled: (enabled: boolean) => Promise<void>;
      setSpellCheckEnabled: (enabled: boolean) => Promise<void>;
      setSpellCheckLanguage: (language: string) => Promise<void>;
    };
  };
  spell: {
    dictionaries: Accessor<DictionaryInfo[]>;
    showInstallHelp: () => void;
    showAddedWords: () => void;
  };
  showAbout: () => Promise<void>;
};

const commandShortcut = (isMac: boolean, key: string, withShift = false) => `${isMac ? "Cmd" : "Ctrl"}${withShift ? "+Shift" : ""}+${key}`;

export const buildCommands = (deps: BuildCommandsDeps): { definitions: CommandDefinition[]; sections: MenuSection[] } => {
  const definitions: CommandDefinition[] = [
    {
      id: "file.new",
      label: "New",
      shortcut: commandShortcut(deps.platform.isMac, "N"),
      run: () => deps.closeFlow.runOrConfirmDiscard(deps.fileLifecycle.newFile)
    },
    {
      id: "file.open",
      label: "Open",
      shortcut: commandShortcut(deps.platform.isMac, "O"),
      run: () => deps.closeFlow.runOrConfirmDiscard(deps.fileLifecycle.openFile)
    },
    {
      id: "file.save",
      label: "Save",
      shortcut: commandShortcut(deps.platform.isMac, "S"),
      run: deps.fileLifecycle.saveFile
    },
    {
      id: "file.saveAs",
      label: "Save As",
      shortcut: commandShortcut(deps.platform.isMac, "S", true),
      run: deps.fileLifecycle.saveFileAs
    },
    {
      id: "file.quit",
      label: "Quit",
      shortcut: commandShortcut(deps.platform.isMac, "Q"),
      run: deps.closeFlow.requestClose
    },
    {
      id: "file.recent.1",
      label: "Recent File 1",
      getLabel: () => {
        const f = deps.settings.state.recentFiles[0];
        return f ? `1. ${fileNameFromPath(f)}` : "1.";
      },
      shortcut: commandShortcut(deps.platform.isMac, "1"),
      enabled: () => deps.settings.state.recentFiles.length >= 1,
      run: () => deps.closeFlow.runOrConfirmDiscard(() => deps.fileLifecycle.openFileAtPath(deps.settings.state.recentFiles[0]))
    },
    {
      id: "file.recent.2",
      label: "Recent File 2",
      getLabel: () => {
        const f = deps.settings.state.recentFiles[1];
        return f ? `2. ${fileNameFromPath(f)}` : "2.";
      },
      shortcut: commandShortcut(deps.platform.isMac, "2"),
      enabled: () => deps.settings.state.recentFiles.length >= 2,
      run: () => deps.closeFlow.runOrConfirmDiscard(() => deps.fileLifecycle.openFileAtPath(deps.settings.state.recentFiles[1]))
    },
    {
      id: "file.recent.3",
      label: "Recent File 3",
      getLabel: () => {
        const f = deps.settings.state.recentFiles[2];
        return f ? `3. ${fileNameFromPath(f)}` : "3.";
      },
      shortcut: commandShortcut(deps.platform.isMac, "3"),
      enabled: () => deps.settings.state.recentFiles.length >= 3,
      run: () => deps.closeFlow.runOrConfirmDiscard(() => deps.fileLifecycle.openFileAtPath(deps.settings.state.recentFiles[2]))
    },
    {
      id: "edit.undo",
      label: "Undo",
      shortcut: commandShortcut(deps.platform.isMac, "Z"),
      refocusEditorOnMenuSelect: true,
      skipWhenTextInputFocused: true,
      run: () => {
        deps.editor.undoEdit();
      }
    },
    {
      id: "edit.redo",
      label: "Redo",
      shortcut: deps.platform.isMac ? commandShortcut(true, "Z", true) : commandShortcut(false, "Y"),
      refocusEditorOnMenuSelect: true,
      skipWhenTextInputFocused: true,
      run: () => {
        deps.editor.redoEdit();
      }
    },
    ...(!deps.platform.isMac
      ? [{
        id: "edit.redo.alt",
        label: "Redo",
        shortcut: commandShortcut(false, "Z", true),
        refocusEditorOnMenuSelect: true,
        skipWhenTextInputFocused: true,
        run: () => {
          deps.editor.redoEdit();
        }
      } satisfies CommandDefinition]
      : []),
    {
      id: "edit.cut",
      label: "Cut",
      shortcut: commandShortcut(deps.platform.isMac, "X"),
      refocusEditorOnMenuSelect: true,
      skipWhenTextInputFocused: true,
      run: async () => {
        await deps.editor.cutSelection();
      }
    },
    {
      id: "edit.copy",
      label: "Copy",
      shortcut: commandShortcut(deps.platform.isMac, "C"),
      refocusEditorOnMenuSelect: true,
      skipWhenTextInputFocused: true,
      run: async () => {
        await deps.editor.copySelection();
      }
    },
    {
      id: "edit.paste",
      label: "Paste",
      shortcut: commandShortcut(deps.platform.isMac, "V"),
      refocusEditorOnMenuSelect: true,
      skipWhenTextInputFocused: true,
      run: async () => {
        await deps.editor.pasteSelection();
      }
    },
    {
      id: "edit.find",
      label: "Find...",
      shortcut: commandShortcut(deps.platform.isMac, "F"),
      run: () => {
        deps.editor.openOrFocusFindPanel();
      }
    },
    {
      id: "edit.find.altReplaceKey",
      label: "Replace...",
      shortcut: commandShortcut(deps.platform.isMac, "H"),
      run: () => {
        deps.editor.openOrFocusReplacePanel();
      }
    },
    {
      id: "edit.transcriptMode",
      label: "Transcript Mode",
      shortcut: "F4",
      refocusEditorOnMenuSelect: true,
      run: () => {
        const enabled = !deps.transcriptMode.enabled();
        deps.transcriptMode.setEnabled(enabled);
        deps.editor.setTranscriptMode(enabled);
      },
      checked: () => deps.transcriptMode.enabled()
    },
    {
      id: "format.bold",
      label: "Bold",
      shortcut: commandShortcut(deps.platform.isMac, "B"),
      refocusEditorOnMenuSelect: true,
      run: () => deps.editor.toggleBold()
    },
    {
      id: "format.italic",
      label: "Italic",
      shortcut: commandShortcut(deps.platform.isMac, "I"),
      refocusEditorOnMenuSelect: true,
      run: () => deps.editor.toggleItalic()
    },
    ...([1, 2, 3, 4, 5, 6] as const).map((level): CommandDefinition => ({
      id: `format.heading.${level}`,
      label: `Heading ${level}`,
      shortcut: `${deps.platform.isMac ? "Cmd" : "Ctrl"}+Alt+${level}`,
      refocusEditorOnMenuSelect: true,
      run: () => deps.editor.applyHeadingLevel(level)
    })),
    {
      id: "format.heading.normal",
      label: "Normal Text",
      shortcut: `${deps.platform.isMac ? "Cmd" : "Ctrl"}+Alt+0`,
      refocusEditorOnMenuSelect: true,
      run: () => deps.editor.applyHeadingLevel(0)
    },
    {
      id: "view.theme.light",
      label: "Light Theme",
      refocusEditorOnMenuSelect: true,
      run: () => deps.settings.actions.setThemeMode("light"),
      checked: () => deps.settings.state.themeMode === "light"
    },
    {
      id: "view.theme.dark",
      label: "Dark Theme",
      refocusEditorOnMenuSelect: true,
      run: () => deps.settings.actions.setThemeMode("dark"),
      checked: () => deps.settings.state.themeMode === "dark"
    },
    {
      id: "view.wrap",
      label: "Text Wrap",
      shortcut: "Alt+Z",
      refocusEditorOnMenuSelect: true,
      run: () => deps.settings.actions.setTextWrapEnabled(!deps.settings.state.textWrapEnabled),
      enabled: () => !deps.fileLifecycle.safeModeActive(),
      checked: () => !deps.fileLifecycle.safeModeActive() && deps.settings.state.textWrapEnabled
    },
    {
      id: "view.formatMode",
      label: "Formatted View",
      shortcut: "Alt+M",
      refocusEditorOnMenuSelect: true,
      run: () =>
        deps.editor.setFormatMode(deps.editor.getFormatMode() === "formatted" ? "plain" : "formatted"),
      checked: () => deps.settings.state.formatViewMode === "formatted"
    },
    {
      id: "view.activeLineHighlight",
      label: "Highlight Current Line",
      refocusEditorOnMenuSelect: true,
      run: () =>
        deps.settings.actions.setActiveLineHighlightEnabled(!deps.settings.state.activeLineHighlightEnabled),
      checked: () => deps.settings.state.activeLineHighlightEnabled
    },
    {
      id: "view.statusBar",
      label: "Status Bar",
      refocusEditorOnMenuSelect: true,
      run: () => deps.settings.actions.setStatusBarEnabled(!deps.settings.state.statusBarEnabled),
      checked: () => deps.settings.state.statusBarEnabled
    },
    {
      id: "view.spellCheck.off",
      label: "Off",
      refocusEditorOnMenuSelect: true,
      run: () => deps.settings.actions.setSpellCheckEnabled(false),
      checked: () => !deps.settings.state.spellCheckEnabled
    },
    {
      id: "view.spellCheck.none",
      label: "No dictionaries installed",
      enabled: () => false,
      run: () => {}
    },
    {
      id: "view.spellCheck.help",
      label: "How to Install Dictionaries...",
      run: () => deps.spell.showInstallHelp()
    },
    {
      id: "view.spellCheck.addedWords",
      label: "Added Words...",
      run: () => deps.spell.showAddedWords()
    },
    {
      id: "view.font.browser",
      label: "Font...",
      refocusEditorOnMenuSelect: true,
      run: deps.fileLifecycle.chooseEditorFont
    },
    {
      id: "help.about",
      label: "About Wisty",
      run: deps.showAbout
    }
  ];

  const sections: MenuSection[] = [
    {
      id: "file",
      label: "File",
      items: [
        { type: "command", commandId: "file.new" },
        { type: "command", commandId: "file.open" },
        { type: "separator" },
        { type: "command", commandId: "file.save" },
        { type: "command", commandId: "file.saveAs" },
        { type: "separator", visible: () => deps.settings.state.recentFiles.length > 0 },
        { type: "command", commandId: "file.recent.1", visible: () => deps.settings.state.recentFiles.length >= 1 },
        { type: "command", commandId: "file.recent.2", visible: () => deps.settings.state.recentFiles.length >= 2 },
        { type: "command", commandId: "file.recent.3", visible: () => deps.settings.state.recentFiles.length >= 3 },
        { type: "separator" },
        { type: "command", commandId: "file.quit" }
      ]
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        { type: "command", commandId: "edit.undo" },
        { type: "command", commandId: "edit.redo" },
        { type: "separator" },
        { type: "command", commandId: "edit.cut" },
        { type: "command", commandId: "edit.copy" },
        { type: "command", commandId: "edit.paste" },
        { type: "separator" },
        { type: "command", commandId: "edit.find" },
        { type: "command", commandId: "edit.find.altReplaceKey" },
        { type: "separator" },
        { type: "command", commandId: "edit.transcriptMode" }
      ]
    },
    {
      id: "format",
      label: "Format",
      items: [
        { type: "command", commandId: "format.bold" },
        { type: "command", commandId: "format.italic" },
        { type: "separator" },
        {
          type: "submenu",
          id: "format.heading",
          label: "Heading",
          items: (): MenuItem[] => [
            { type: "command", commandId: "format.heading.1" },
            { type: "command", commandId: "format.heading.2" },
            { type: "command", commandId: "format.heading.3" },
            { type: "command", commandId: "format.heading.4" },
            { type: "command", commandId: "format.heading.5" },
            { type: "command", commandId: "format.heading.6" },
            { type: "separator" },
            { type: "command", commandId: "format.heading.normal" }
          ]
        }
      ]
    },
    {
      id: "view",
      label: "View",
      items: [
        { type: "command", commandId: "view.theme.light" },
        { type: "command", commandId: "view.theme.dark" },
        { type: "separator" },
        { type: "command", commandId: "view.wrap" },
        { type: "command", commandId: "view.formatMode" },
        { type: "command", commandId: "view.activeLineHighlight" },
        { type: "command", commandId: "view.statusBar" },
        {
          type: "submenu",
          id: "view.spellCheck",
          label: "Spell Check",
          items: (): MenuItem[] => {
            const dictionaries = deps.spell.dictionaries();
            if (dictionaries.length === 0) {
              return [
                { type: "command", commandId: "view.spellCheck.none" },
                { type: "command", commandId: "view.spellCheck.help" },
                { type: "command", commandId: "view.spellCheck.addedWords" }
              ];
            }
            return [
              { type: "command", commandId: "view.spellCheck.off" },
              { type: "separator" },
              ...dictionaries.map((dictionary): MenuItem => ({
                type: "command",
                commandId: spellLanguageCommandId(dictionary.code)
              })),
              { type: "separator" },
              { type: "command", commandId: "view.spellCheck.addedWords" }
            ];
          }
        },
        { type: "separator" },
        { type: "command", commandId: "view.font.browser" }
      ]
    },
    {
      id: "help",
      label: "Help",
      items: [{ type: "command", commandId: "help.about" }]
    }
  ];

  return { definitions, sections };
};
