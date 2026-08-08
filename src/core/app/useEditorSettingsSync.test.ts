/**
 * The settings the editor must be told about.
 *
 * Each case here stands for one reading in the effect. They look repetitive
 * because that is the point: the effect's correctness *is* the list, and a
 * reading dropped from it fails exactly one of these rather than nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { useEditorSettingsSync } from "./useEditorSettingsSync";

import type { FormatViewMode } from "../settings/settingsTypes";

const INITIAL: {
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
} = {
  themeMode: "light",
  fontFamily: "sans-serif",
  fontSize: 14,
  fontStyle: "normal",
  fontWeight: 400,
  textWrapEnabled: true,
  activeLineHighlightEnabled: true,
  statusBarEnabled: true,
  formatViewMode: "plain",
  spellCheckEnabled: false,
  spellCheckLanguage: "en_US"
};

const setup = () => {
  const [state, setState] = createStore({ ...INITIAL });
  const editor = {
    applySettings: vi.fn(),
    setFormatMode: vi.fn(),
    configureSpellcheck: vi.fn()
  };
  const applyTheme = vi.fn();
  let dispose = () => {};

  createRoot((disposeRoot) => {
    dispose = disposeRoot;
    useEditorSettingsSync({ settings: { state }, editor, applyTheme });
  });

  return { state, setState, editor, applyTheme, dispose };
};

describe("carrying settings into the editor", () => {
  it("applies them once at the start", () => {
    const { editor, applyTheme, dispose } = setup();

    expect(editor.applySettings).toHaveBeenCalledTimes(1);
    expect(applyTheme).toHaveBeenCalledWith("light");
    expect(editor.setFormatMode).toHaveBeenCalledWith("plain");
    expect(editor.configureSpellcheck).toHaveBeenCalledWith({
      enabled: false,
      language: "en_US"
    });
    dispose();
  });

  const appliedOnChange = (
    change: Record<string, unknown>
  ) => {
    const { setState, editor, dispose } = setup();
    const before = editor.applySettings.mock.calls.length;
    setState(change);
    const after = editor.applySettings.mock.calls.length;
    dispose();
    return after > before;
  };

  it("applies them again when the theme changes", () => {
    expect(appliedOnChange({ themeMode: "dark" })).toBe(true);
  });

  it("applies them again when the font changes", () => {
    expect(appliedOnChange({ fontFamily: "serif" })).toBe(true);
    expect(appliedOnChange({ fontSize: 18 })).toBe(true);
    expect(appliedOnChange({ fontStyle: "italic" })).toBe(true);
    expect(appliedOnChange({ fontWeight: 700 })).toBe(true);
  });

  it("applies them again when wrapping or the active line changes", () => {
    expect(appliedOnChange({ textWrapEnabled: false })).toBe(true);
    expect(appliedOnChange({ activeLineHighlightEnabled: false })).toBe(true);
  });

  /**
   * The one that was missing. Hiding or showing the status bar decides whether
   * the editor counts the document's words, so the editor has to hear about it
   * — and it only hears through this effect.
   */
  it("applies them again when the status bar is shown or hidden", () => {
    expect(appliedOnChange({ statusBarEnabled: false })).toBe(true);
  });

  it("passes a new format mode straight to the editor", () => {
    const { setState, editor, dispose } = setup();

    setState({ formatViewMode: "formatted" });

    expect(editor.setFormatMode).toHaveBeenLastCalledWith("formatted");
    dispose();
  });

  it("passes new spellcheck settings straight to the editor", () => {
    const { setState, editor, dispose } = setup();

    setState({ spellCheckEnabled: true, spellCheckLanguage: "en_GB" });

    expect(editor.configureSpellcheck).toHaveBeenLastCalledWith({
      enabled: true,
      language: "en_GB"
    });
    dispose();
  });

  /** Settings the editor does not render from must not set it working. */
  it("leaves the editor alone when the theme changes and nothing else", () => {
    const { setState, editor, applyTheme, dispose } = setup();
    const formatCalls = editor.setFormatMode.mock.calls.length;

    setState({ themeMode: "dark" });

    expect(applyTheme).toHaveBeenLastCalledWith("dark");
    expect(editor.setFormatMode.mock.calls.length).toBe(formatCalls);
    dispose();
  });
});
