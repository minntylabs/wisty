import { describe, expect, it, vi } from "vitest";
import { buildCommands } from "./buildCommands";
import { MENU_ID_BY_MNEMONIC } from "../app/useMenuState";
import type { FormatViewMode } from "../settings/settingsTypes";

const createDeps = (overrides: {
  formatViewMode?: FormatViewMode;
  activeLineHighlightEnabled?: boolean;
  canRememberPosition?: boolean;
  isPositionRemembered?: boolean;
  markersVisible?: boolean;
  isContainerDocument?: boolean;
  isImporting?: boolean;
} = {}) => {
  const settingsState = {
    themeMode: "light" as const,
    textWrapEnabled: true,
    activeLineHighlightEnabled: overrides.activeLineHighlightEnabled ?? false,
    formatViewMode: overrides.formatViewMode ?? "plain",
    markersVisible: overrides.markersVisible ?? true,
    statusBarEnabled: true,
    spellCheckEnabled: false,
    spellCheckLanguage: "en_US",
    recentFiles: [] as string[]
  };

  let transcriptModeEnabled = false;
  const rememberedPositionState = {
    canRemember: overrides.canRememberPosition ?? true,
    isRemembered: overrides.isPositionRemembered ?? false
  };

  const deps = {
    platform: { isMac: false },
    closeFlow: {
      runOrConfirmDiscard: vi.fn(async (action: () => Promise<void>) => action()),
      requestClose: vi.fn(async () => {})
    },
    fileLifecycle: {
      newFile: vi.fn(async () => {}),
      openFile: vi.fn(async () => {}),
      openFileAtPath: vi.fn(async () => {}),
      saveFile: vi.fn(async () => {}),
      saveFileAs: vi.fn(async () => {}),
      exportText: vi.fn(async () => {}),
      importTranscript: vi.fn(async () => {}),
      chooseEditorFont: vi.fn(async () => {}),
      safeModeActive: () => false,
      isImporting: () => overrides.isImporting ?? false
    },
    editor: {
      undoEdit: vi.fn(() => true),
      redoEdit: vi.fn(() => true),
      cutSelection: vi.fn(async () => true),
      copySelection: vi.fn(async () => true),
      pasteSelection: vi.fn(async () => true),
      openOrFocusFindPanel: vi.fn(() => true),
      openOrFocusReplacePanel: vi.fn(() => true),
      setFormatMode: vi.fn(),
      getFormatMode: vi.fn(() => settingsState.formatViewMode),
      setMarkersVisible: vi.fn(),
      toggleBold: vi.fn(),
      toggleItalic: vi.fn(),
      applyHeadingLevel: vi.fn(),
      setTranscriptMode: vi.fn()
    },
    isContainerDocument: () => overrides.isContainerDocument ?? false,
    transcriptMode: {
      enabled: () => transcriptModeEnabled,
      setEnabled: vi.fn((enabled: boolean) => {
        transcriptModeEnabled = enabled;
      })
    },
    rememberedPosition: {
      canRemember: () => rememberedPositionState.canRemember,
      isRemembered: () => rememberedPositionState.isRemembered,
      toggle: vi.fn(async () => {
        rememberedPositionState.isRemembered = !rememberedPositionState.isRemembered;
      })
    },
    settings: {
      state: settingsState,
      actions: {
        setThemeMode: vi.fn(async () => {}),
        setTextWrapEnabled: vi.fn(async () => {}),
        setActiveLineHighlightEnabled: vi.fn(async (enabled: boolean) => {
          settingsState.activeLineHighlightEnabled = enabled;
        }),
        setStatusBarEnabled: vi.fn(async () => {}),
        setMarkersVisible: vi.fn(async (visible: boolean) => {
          settingsState.markersVisible = visible;
        }),
        setSpellCheckEnabled: vi.fn(async () => {}),
        setSpellCheckLanguage: vi.fn(async () => {})
      }
    },
    spell: {
      dictionaries: () => [],
      showInstallHelp: vi.fn(),
      showAddedWords: vi.fn()
    },
    showAbout: vi.fn(async () => {})
  };

  return deps;
};

const findCommand = (definitions: ReturnType<typeof buildCommands>["definitions"], id: string) => {
  const command = definitions.find((definition) => definition.id === id);
  if (!command) {
    throw new Error(`command not found: ${id}`);
  }
  return command;
};

describe("format commands", () => {
  it("bold and italic commands are bound to Ctrl+B / Ctrl+I and invoke the editor", () => {
    const deps = createDeps();
    const { definitions } = buildCommands(deps);

    const bold = findCommand(definitions, "format.bold");
    expect(bold.shortcut).toBe("Ctrl+B");
    bold.run();
    expect(deps.editor.toggleBold).toHaveBeenCalledOnce();

    const italic = findCommand(definitions, "format.italic");
    expect(italic.shortcut).toBe("Ctrl+I");
    italic.run();
    expect(deps.editor.toggleItalic).toHaveBeenCalledOnce();
  });

  it("uses Cmd on macOS instead of Ctrl", () => {
    const deps = createDeps();
    deps.platform.isMac = true;
    const { definitions } = buildCommands(deps);
    expect(findCommand(definitions, "format.bold").shortcut).toBe("Cmd+B");
  });

  it("registers heading commands 1-6 plus a clear-heading command, each calling applyHeadingLevel", () => {
    const deps = createDeps();
    const { definitions } = buildCommands(deps);

    for (const level of [1, 2, 3, 4, 5, 6]) {
      const command = findCommand(definitions, `format.heading.${level}`);
      expect(command.shortcut).toBe(`Ctrl+Alt+${level}`);
      command.run();
      expect(deps.editor.applyHeadingLevel).toHaveBeenLastCalledWith(level);
    }

    const normal = findCommand(definitions, "format.heading.normal");
    expect(normal.shortcut).toBe("Ctrl+Alt+0");
    normal.run();
    expect(deps.editor.applyHeadingLevel).toHaveBeenLastCalledWith(0);
  });

  it("lists the Format menu section with Bold, Italic and a Heading submenu", () => {
    const deps = createDeps();
    const { sections } = buildCommands(deps);
    const formatSection = sections.find((section) => section.id === "format");
    expect(formatSection).toBeDefined();

    const ids = formatSection!.items.map((item) => (item.type === "command" ? item.commandId : item.type === "submenu" ? item.id : "separator"));
    expect(ids).toEqual(["format.bold", "format.italic", "separator", "format.heading"]);

    const headingSubmenu = formatSection!.items.find((item) => item.type === "submenu" && item.id === "format.heading");
    expect(headingSubmenu?.type).toBe("submenu");
    if (headingSubmenu?.type === "submenu") {
      const headingIds = headingSubmenu.items().map((item) => (item.type === "command" ? item.commandId : "separator"));
      expect(headingIds).toEqual([
        "format.heading.1",
        "format.heading.2",
        "format.heading.3",
        "format.heading.4",
        "format.heading.5",
        "format.heading.6",
        "separator",
        "format.heading.normal"
      ]);
    }
  });
});

describe("view.formatMode command", () => {
  it("toggles from plain to formatted via the live editor mode, not the persisted setting", () => {
    const deps = createDeps({ formatViewMode: "plain" });
    const { definitions } = buildCommands(deps);
    const command = findCommand(definitions, "view.formatMode");

    expect(command.shortcut).toBe("Alt+M");
    expect(command.checked!()).toBe(false);

    command.run();

    expect(deps.editor.getFormatMode).toHaveBeenCalled();
    expect(deps.editor.setFormatMode).toHaveBeenCalledWith("formatted");
  });

  it("toggles from formatted back to plain when the live mode is already formatted", () => {
    const deps = createDeps();
    deps.editor.getFormatMode = vi.fn(() => "formatted");
    const { definitions } = buildCommands(deps);
    findCommand(definitions, "view.formatMode").run();
    expect(deps.editor.setFormatMode).toHaveBeenCalledWith("plain");
  });

  it("checked() reflects the persisted formatViewMode setting", () => {
    const deps = createDeps({ formatViewMode: "formatted" });
    const { definitions } = buildCommands(deps);
    expect(findCommand(definitions, "view.formatMode").checked!()).toBe(true);
  });
});

describe("view.activeLineHighlight command", () => {
  it("is unchecked by default and toggles the setting on when run", async () => {
    const deps = createDeps({ activeLineHighlightEnabled: false });
    const { definitions } = buildCommands(deps);
    const command = findCommand(definitions, "view.activeLineHighlight");

    expect(command.label).toBe("Highlight Current Line");
    expect(command.checked!()).toBe(false);

    await command.run();

    expect(deps.settings.actions.setActiveLineHighlightEnabled).toHaveBeenCalledWith(true);
    expect(command.checked!()).toBe(true);
  });

  it("toggles back off when already enabled", async () => {
    const deps = createDeps({ activeLineHighlightEnabled: true });
    const { definitions } = buildCommands(deps);
    await findCommand(definitions, "view.activeLineHighlight").run();
    expect(deps.settings.actions.setActiveLineHighlightEnabled).toHaveBeenCalledWith(false);
  });

  it("is listed in the View menu section", () => {
    const deps = createDeps();
    const { sections } = buildCommands(deps);
    const viewSection = sections.find((section) => section.id === "view");
    const ids = viewSection!.items.map((item) => (item.type === "command" ? item.commandId : item.type === "submenu" ? item.id : "separator"));
    expect(ids).toContain("view.activeLineHighlight");
  });
});

describe("remember position command", () => {
  it("sits in the View menu and reflects whether the file has a stored entry", () => {
    const deps = createDeps({ isPositionRemembered: true });
    const { definitions, sections } = buildCommands(deps);
    const command = findCommand(definitions, "view.rememberPosition");

    expect(command.label).toBe("Remember Position");
    expect(command.checked?.()).toBe(true);
    expect(sections.find((section) => section.id === "view")?.items).toContainEqual({
      type: "command",
      commandId: "view.rememberPosition"
    });
  });

  it("is disabled for an untitled document, which has no path to key by", () => {
    const deps = createDeps({ canRememberPosition: false });
    const command = findCommand(buildCommands(deps).definitions, "view.rememberPosition");
    expect(command.enabled?.()).toBe(false);
  });

  it("toggles the entry on and off", async () => {
    const deps = createDeps();
    const command = findCommand(buildCommands(deps).definitions, "view.rememberPosition");
    expect(command.checked?.()).toBe(false);
    await command.run();
    expect(command.checked?.()).toBe(true);
    await command.run();
    expect(command.checked?.()).toBe(false);
  });
});

describe("file.importTranscript command", () => {
  it("is bound to Alt+Shift+I and asks about unsaved work first", async () => {
    const deps = createDeps();
    const command = findCommand(buildCommands(deps).definitions, "file.importTranscript");

    expect(command.shortcut).toBe("Alt+Shift+I");
    expect(command.enabled?.()).toBe(true);
    await command.run();
    expect(deps.closeFlow.runOrConfirmDiscard).toHaveBeenCalledOnce();
    expect(deps.fileLifecycle.importTranscript).toHaveBeenCalledOnce();
  });

  /** A second import is refused, so it should not be offered. */
  it("is disabled while an import is running", () => {
    const deps = createDeps({ isImporting: true });
    const command = findCommand(buildCommands(deps).definitions, "file.importTranscript");
    expect(command.enabled?.()).toBe(false);
  });
});

/**
 * Two commands on one shortcut is a bug the router cannot report: it runs
 * whichever it finds first, and the other simply never happens.
 */
/**
 * WebKitGTK handles these itself, below the page: the inspector opens and the
 * command never runs, and `preventDefault` cannot reach far enough down to
 * stop it. Ctrl+Shift+I cost an import shortcut that way.
 */
const CLAIMED_BY_THE_WEBVIEW = ["Ctrl+Shift+I", "Ctrl+Shift+C", "F12"];

describe("shortcuts", () => {
  /**
   * Alt plus a menu's letter opens that menu, and the router never sees the
   * event. A command bound to the same combination is simply unreachable.
   */
  it("leaves the menu mnemonics alone", () => {
    const deps = createDeps();
    const swallowed = buildCommands(deps)
      .definitions.filter((definition) => /^Alt\+[A-Za-z]$/.test(definition.shortcut ?? ""))
      .filter((definition) => MENU_ID_BY_MNEMONIC[(definition.shortcut as string).slice(-1).toLowerCase()])
      .map((definition) => `${definition.shortcut} (${definition.id})`);

    expect(swallowed, "these open a menu instead of running").toEqual([]);
  });

  it("leaves the webview's own shortcuts alone", () => {
    const deps = createDeps();
    const taken = buildCommands(deps)
      .definitions.filter((definition) => definition.shortcut)
      .filter((definition) => CLAIMED_BY_THE_WEBVIEW.includes(definition.shortcut as string))
      .map((definition) => `${definition.shortcut} (${definition.id})`);

    expect(taken, "WebKitGTK answers these before the page does").toEqual([]);
  });


  it("gives no shortcut to two commands", () => {
    for (const isMac of [false, true]) {
      const deps = createDeps();
      deps.platform.isMac = isMac;
      const bound = buildCommands(deps)
        .definitions.filter((definition) => definition.shortcut)
        .map((definition) => `${definition.shortcut} (${definition.id})`);

      const seen = new Map<string, string>();
      const clashes: string[] = [];
      for (const entry of bound) {
        const shortcut = entry.slice(0, entry.indexOf(" ("));
        const owner = seen.get(shortcut);
        if (owner) {
          clashes.push(`${shortcut}: ${owner} and ${entry}`);
        }
        seen.set(shortcut, entry);
      }

      expect(clashes, `on ${isMac ? "macOS" : "Linux"}`).toEqual([]);
    }
  });
});
