import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const createAdapter = (settingsOverrides: Partial<typeof settings> = {}) => {
  const onDocChanged = vi.fn();
  const onCursorPositionChanged = vi.fn();
  const onFormatModeChanged = vi.fn();
  const onWordCountChanged = vi.fn();
  const adapter = createEditorAdapter({
    getSettings: () => ({ ...settings, ...settingsOverrides }),
    onDocChanged,
    onCursorPositionChanged,
    onFormatModeChanged,
    onWordCountChanged
  });
  adapters.push(adapter);
  const host = document.createElement("div");
  document.body.append(host);
  adapter.setHost(host);
  adapter.init();
  return { adapter, host, onDocChanged, onCursorPositionChanged, onFormatModeChanged, onWordCountChanged };
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

/**
 * Characters are counted behind the caret, out of the characters the line
 * actually has. The arithmetic decides whether a line holding one character can
 * be described as holding two, so both ends of that line are covered here:
 * `setText` leaves the caret before the text, and a paste leaves it after.
 */
describe("cursor position", () => {
  const lastPosition = (onCursorPositionChanged: ReturnType<typeof vi.fn>) => {
    const { calls } = onCursorPositionChanged.mock;
    return calls[calls.length - 1]?.[0];
  };

  it("counts no characters behind a caret in front of the only one on the line", () => {
    const { adapter, onCursorPositionChanged } = createAdapter();

    adapter.setText("a");

    expect(lastPosition(onCursorPositionChanged)).toMatchObject({
      currentCharacter: 0,
      totalCharacters: 1
    });
  });

  it("counts the one behind a caret that has passed it", async () => {
    const { adapter, onCursorPositionChanged } = createAdapter();
    readText.mockResolvedValue("a");

    await adapter.pasteSelection();

    expect(lastPosition(onCursorPositionChanged)).toMatchObject({
      currentCharacter: 1,
      totalCharacters: 1
    });
  });

  it("reports no characters at all on an empty document", () => {
    const { adapter, onCursorPositionChanged } = createAdapter();

    adapter.setText("");

    expect(lastPosition(onCursorPositionChanged)).toMatchObject({
      currentLine: 1,
      totalLines: 1,
      currentCharacter: 0,
      totalCharacters: 0
    });
  });

  /** The total is the caret's own line, not the document. */
  it("counts the characters of the line the caret is on", () => {
    const { adapter, onCursorPositionChanged } = createAdapter();

    adapter.setText("first\nsecond line");

    expect(lastPosition(onCursorPositionChanged)).toMatchObject({
      currentLine: 1,
      totalLines: 2,
      currentCharacter: 0,
      totalCharacters: 5
    });
  });
});

/**
 * The count is taken from the document CodeMirror is holding, after typing
 * stops. These use fake timers so the wait is not really waited for.
 */
describe("word count", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the document once typing stops", async () => {
    const { adapter, onWordCountChanged } = createAdapter();

    adapter.setText("one two three\nfour five");
    // Not counted yet, and said so rather than showing a number for it.
    expect(onWordCountChanged).toHaveBeenLastCalledWith(null);

    await vi.runAllTimersAsync();

    expect(onWordCountChanged).toHaveBeenLastCalledWith(5);
  });

  /**
   * The count on screen belongs to the document on screen. A new document has
   * none until it has been counted, and must never wear the last one's.
   */
  it("forgets the last document's count the moment it is replaced", async () => {
    const { adapter, onWordCountChanged } = createAdapter();
    adapter.setText("one two three");
    await vi.runAllTimersAsync();
    expect(onWordCountChanged).toHaveBeenLastCalledWith(3);

    adapter.reset();

    expect(onWordCountChanged).toHaveBeenLastCalledWith(null);
  });

  /**
   * Resetting replaces the state outright, which is not an edit, so nothing
   * would ask for a count if the reset did not ask itself.
   */
  it("counts the empty document a reset leaves behind", async () => {
    const { adapter, onWordCountChanged } = createAdapter();
    adapter.setText("one two three");
    await vi.runAllTimersAsync();

    adapter.reset();
    await vi.runAllTimersAsync();

    expect(onWordCountChanged).toHaveBeenLastCalledWith(0);
  });

  /**
   * A scan reads the document as it is when it runs, so a count that lands
   * after several edits is right whether or not each edit asked for one. This
   * is the case that proves each edit does: the first count has already
   * settled before the document changes again.
   */
  it("counts again after an edit that follows a settled count", async () => {
    const { adapter, onWordCountChanged } = createAdapter();

    adapter.setText("one two");
    await vi.runAllTimersAsync();
    expect(onWordCountChanged).toHaveBeenLastCalledWith(2);

    adapter.setText("one two three four");
    await vi.runAllTimersAsync();

    expect(onWordCountChanged).toHaveBeenLastCalledWith(4);
  });

  it("reports the count of the document that is open now", async () => {
    const { adapter, onWordCountChanged } = createAdapter();

    adapter.setText("one two three");
    adapter.setText("only");
    await vi.runAllTimersAsync();

    expect(onWordCountChanged).toHaveBeenLastCalledWith(1);
  });

  it("counts an empty document as no words", async () => {
    const { adapter, onWordCountChanged } = createAdapter();

    adapter.setText("");
    await vi.runAllTimersAsync();

    expect(onWordCountChanged).toHaveBeenLastCalledWith(0);
  });

  /** Nothing displays it, so a large document is not scanned for it. */
  it("does not count while the status bar is hidden", async () => {
    const { adapter, onWordCountChanged } = createAdapter({ statusBarEnabled: false });

    adapter.setText("one two three");
    await vi.runAllTimersAsync();

    expect(onWordCountChanged).not.toHaveBeenCalledWith(3);
  });

  it("counts as soon as the status bar is shown again", async () => {
    const hidden = { statusBarEnabled: false };
    const { adapter, onWordCountChanged } = createAdapter(hidden);
    adapter.setText("one two three");
    await vi.runAllTimersAsync();

    hidden.statusBarEnabled = true;
    adapter.applySettings();
    await vi.runAllTimersAsync();

    expect(onWordCountChanged).toHaveBeenLastCalledWith(3);
  });

  /**
   * The scan is the expensive part, so it may not be set off by settings that
   * cannot change a word — a theme change must not rescan a large document.
   */
  it("does not recount when a setting unrelated to it changes", async () => {
    const { adapter, onWordCountChanged } = createAdapter();
    adapter.setText("one two three");
    await vi.runAllTimersAsync();
    const countsSoFar = onWordCountChanged.mock.calls.length;

    adapter.applySettings();
    await vi.runAllTimersAsync();

    expect(onWordCountChanged.mock.calls.length).toBe(countsSoFar);
  });

  /** Hidden, the count goes stale, so it is dropped rather than kept. */
  it("forgets the count while the status bar is hidden", async () => {
    const shown = { statusBarEnabled: true };
    const { adapter, onWordCountChanged } = createAdapter(shown);
    adapter.setText("one two three");
    await vi.runAllTimersAsync();
    expect(onWordCountChanged).toHaveBeenLastCalledWith(3);

    shown.statusBarEnabled = false;
    adapter.applySettings();

    expect(onWordCountChanged).toHaveBeenLastCalledWith(null);
  });

  it("stops counting once the editor is torn down", async () => {
    const { adapter, onWordCountChanged } = createAdapter();

    adapter.setText("one two three");
    adapter.destroy();
    await vi.runAllTimersAsync();

    expect(onWordCountChanged).not.toHaveBeenCalledWith(3);
  });
});
