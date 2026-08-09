import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeText = vi.hoisted(() => vi.fn());
const readText = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async () => undefined));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText, writeText }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { createEditorAdapter } from "./editorAdapter";
import { transcriptHoverSelection } from "./transcript/transcriptExtension";

/** The live view inside a host, for dispatching what the adapter cannot. */
const viewOf = (host: HTMLElement): EditorView => {
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement);
  if (!view) {
    throw new Error("no editor view in the host");
  }
  return view;
};

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
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

const createAdapter = (settingsOverrides: Partial<typeof settings> = {}) => {
  const onDocChanged = vi.fn();
  const onCursorPositionChanged = vi.fn();
  const onFormatModeChanged = vi.fn();
  const onWordCountChanged = vi.fn();
  const onTranscriptModeChanged = vi.fn();
  const onSpellcheckError = vi.fn();
  const adapter = createEditorAdapter({
    getSettings: () => ({ ...settings, ...settingsOverrides }),
    onDocChanged,
    onCursorPositionChanged,
    onFormatModeChanged,
    onWordCountChanged,
    onTranscriptModeChanged,
    onSpellcheckError
  });
  adapters.push(adapter);
  const host = document.createElement("div");
  document.body.append(host);
  adapter.setHost(host);
  adapter.init();
  return {
    adapter,
    host,
    onDocChanged,
    onCursorPositionChanged,
    onFormatModeChanged,
    onWordCountChanged,
    onTranscriptModeChanged,
    onSpellcheckError
  };
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

describe("clipboard selections", () => {
  it("keeps CRLF between copied ranges", async () => {
    const { adapter, host } = createAdapter();
    adapter.setText("one\r\ntwo");
    const view = viewOf(host);
    const secondLine = view.state.doc.line(2);
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(secondLine.from, secondLine.to)
      ])
    });

    await expect(adapter.copySelection()).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("one\r\ntwo");
  });

  it("does not paste into a document replaced while reading the clipboard", async () => {
    const { adapter } = createAdapter();
    let resolveClipboard: (text: string) => void;
    readText.mockImplementation(
      () => new Promise<string>((resolve) => { resolveClipboard = resolve; })
    );

    const paste = adapter.pasteSelection();
    adapter.setText("replacement");
    resolveClipboard!("stale");

    await expect(paste).resolves.toBe(false);
    expect(adapter.getText()).toBe("replacement");
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

describe("transcript mode and the document it belongs to", () => {
  /**
   * The mode's clicks rewrite the document, and it was only ever switched off
   * by the user. Left on it moved to whatever opened next — including an
   * ordinary text file, where a line like `TODO: fix this` reads as a speaker
   * turn and one click merges it into the line above.
   */
  it("is switched off when the document is replaced", () => {
    const { adapter, onTranscriptModeChanged } = createAdapter();
    adapter.setTranscriptMode(true);
    expect(adapter.isTranscriptModeEnabled()).toBe(true);

    adapter.reset();

    expect(adapter.isTranscriptModeEnabled(), "the mode outlived its document").toBe(false);
    expect(onTranscriptModeChanged, "the menu was left ticked").toHaveBeenCalledWith(false);
  });

  it("says nothing when it was not on to begin with", () => {
    const { adapter, onTranscriptModeChanged } = createAdapter();
    adapter.reset();
    expect(onTranscriptModeChanged).not.toHaveBeenCalled();
  });
});

describe("spell checking that cannot start", () => {
  /**
   * The only caller is a settings effect that discards the promise, so a
   * dictionary that would not load was an unhandled rejection and spell
   * checking quietly off with the menu still showing it enabled.
   */
  it("reports a dictionary that will not load rather than rejecting", async () => {
    const { adapter, onSpellcheckError } = createAdapter();
    const failure = new Error("no such dictionary");
    invoke.mockImplementation(async (command: string) => {
      if (command === "spell_load_dictionary") {
        throw failure;
      }
      return undefined;
    });

    await expect(
      adapter.configureSpellcheck({ enabled: true, language: "xx_YY" })
    ).resolves.toBeUndefined();

    expect(onSpellcheckError).toHaveBeenCalledWith(failure);
  });
});

describe("what a transcript hover does not disturb", () => {
  /**
   * Hovering in transcript mode moves the selection without the caret having
   * been placed anywhere. The status bar's line and character readout followed
   * it, so the numbers changed on every mouse move.
   */
  it("leaves the cursor readout where the caret actually is", () => {
    const { adapter, host, onCursorPositionChanged } = createAdapter();
    adapter.setText("ALICE: one two three\nBOB: four five", { emitChange: false });
    const view = viewOf(host);
    view.dispatch({ selection: { anchor: 8 } });

    const reportsBefore = onCursorPositionChanged.mock.calls.length;
    const at = view.state.doc.toString().indexOf("four");
    view.dispatch({
      selection: { anchor: at, head: at + 4 },
      annotations: transcriptHoverSelection.of(true)
    });

    expect(onCursorPositionChanged.mock.calls.length, "the readout followed the pointer")
      .toBe(reportsBefore);
  });

  it("still reports an ordinary selection change", () => {
    const { adapter, host, onCursorPositionChanged } = createAdapter();
    adapter.setText("ALICE: one two three\nBOB: four five", { emitChange: false });
    const view = viewOf(host);
    view.dispatch({ selection: { anchor: 8 } });

    const reportsBefore = onCursorPositionChanged.mock.calls.length;
    view.dispatch({ selection: { anchor: 12 } });

    expect(onCursorPositionChanged.mock.calls.length).toBeGreaterThan(reportsBefore);
  });
});
