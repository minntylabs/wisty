import { afterEach, describe, expect, it, vi } from "vitest";

const writeText = vi.hoisted(() => vi.fn());
const readText = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText, writeText }));

import { createEditorAdapter } from "./editorAdapter";

const settings = {
  themeMode: "light" as const,
  fontFamily: "sans-serif",
  fontSize: 14,
  fontStyle: "normal" as const,
  fontWeight: 400,
  textWrapEnabled: true,
  activeLineHighlightEnabled: true,
  formatViewMode: "plain" as const,
  markersVisible: true,
  statusBarEnabled: true,
  spellCheckEnabled: false,
  spellCheckLanguage: "en_US",
  lastDirectory: "",
  recentFiles: [],
  rememberedPositions: {}
};

const adapters: ReturnType<typeof createEditorAdapter>[] = [];

afterEach(() => {
  for (const adapter of adapters.splice(0)) {
    adapter.destroy();
  }
  document.body.replaceChildren();
  writeText.mockReset();
  readText.mockReset();
});

const createAdapter = () => {
  const onDocChanged = vi.fn();
  const onCursorPositionChanged = vi.fn();
  const onFormatModeChanged = vi.fn();
  const adapter = createEditorAdapter({
    getSettings: () => settings,
    onDocChanged,
    onCursorPositionChanged,
    onFormatModeChanged
  });
  adapters.push(adapter);
  const host = document.createElement("div");
  document.body.append(host);
  adapter.setHost(host);
  adapter.init();
  return { adapter, host, onDocChanged, onCursorPositionChanged, onFormatModeChanged };
};

describe("editor adapter", () => {
  it("initializes once and reports document revisions", () => {
    const { adapter, host, onDocChanged, onCursorPositionChanged } = createAdapter();

    adapter.init();
    adapter.setText("hello");
    adapter.append(" world", { emitChange: false });

    expect(host.querySelector(".cm-editor")).not.toBeNull();
    expect(adapter.getText()).toBe("hello world");
    expect(adapter.getRevision()).toBe(2);
    expect(onDocChanged).toHaveBeenCalledTimes(1);
    expect(onDocChanged).toHaveBeenLastCalledWith({ revision: 1 });
    expect(onCursorPositionChanged).toHaveBeenCalled();
  });

  it("changes format mode and tears down cleanly", () => {
    const { adapter, host, onFormatModeChanged } = createAdapter();

    adapter.setFormatMode("formatted");
    expect(adapter.getFormatMode()).toBe("formatted");
    expect(onFormatModeChanged).toHaveBeenCalledWith("formatted");

    adapter.destroy();
    expect(host.querySelector(".cm-editor")).toBeNull();
    expect(adapter.getText()).toBe("");
  });
});
