import { afterEach, describe, expect, it, vi } from "vitest";
import { createShortcutRouter } from "./shortcutRouter";
import type { CommandDefinition } from "./commandRegistry";

const createDefinitions = (): CommandDefinition[] => [
  {
    id: "edit.paste",
    label: "Paste",
    shortcut: "Ctrl+V",
    skipWhenTextInputFocused: true,
    run: () => {}
  },
  {
    id: "file.save",
    label: "Save",
    shortcut: "Ctrl+S",
    run: () => {}
  }
];

const dispatchKeydownOn = (
  element: HTMLElement,
  router: ReturnType<typeof createShortcutRouter>,
  init: KeyboardEventInit
): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  let handled = false;
  const listener = (received: Event) => {
    if (!handled) {
      handled = true;
      router.dispatch(received as KeyboardEvent);
    }
  };
  window.addEventListener("keydown", listener);
  element.dispatchEvent(event);
  window.removeEventListener("keydown", listener);
  return event;
};

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * Alt+Shift is the only modifier pair Wisty binds anything to, and the browser
 * reports the shifted letter as uppercase. Matching is exact on every
 * modifier, so this is the combination most easily got wrong.
 */
describe("Alt+Shift shortcuts", () => {
  const withImport = (): CommandDefinition[] => [
    ...createDefinitions(),
    { id: "file.importTranscript", label: "Import", shortcut: "Alt+Shift+I", run: () => {} }
  ];

  it("runs on the uppercase letter the browser reports", () => {
    const execute = vi.fn(async () => true);
    const router = createShortcutRouter({ definitions: withImport(), execute });
    const host = document.createElement("div");
    document.body.appendChild(host);

    const event = dispatchKeydownOn(host, router, { key: "I", altKey: true, shiftKey: true });

    expect(execute).toHaveBeenCalledWith("file.importTranscript");
    expect(event.defaultPrevented).toBe(true);
  });

  /** Alt alone is the menu mnemonics' space, which is checked before this. */
  it("does not run without shift", () => {
    const execute = vi.fn(async () => true);
    const router = createShortcutRouter({ definitions: withImport(), execute });
    const host = document.createElement("div");
    document.body.appendChild(host);

    dispatchKeydownOn(host, router, { key: "i", altKey: true });

    expect(execute).not.toHaveBeenCalled();
  });
});

describe("shortcutRouter text-input handling", () => {
  it("yields editor-scoped shortcuts to native handling when a text input outside the editor has focus", () => {
    const execute = vi.fn(async () => true);
    const router = createShortcutRouter({ definitions: createDefinitions(), execute });

    const input = document.createElement("input");
    document.body.appendChild(input);

    const event = dispatchKeydownOn(input, router, { key: "v", ctrlKey: true });

    expect(execute).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("runs editor-scoped shortcuts when the event comes from the editor content", () => {
    const execute = vi.fn(async () => true);
    const router = createShortcutRouter({ definitions: createDefinitions(), execute });

    const editorContent = document.createElement("div");
    editorContent.className = "cm-content";
    const line = document.createElement("div");
    editorContent.appendChild(line);
    document.body.appendChild(editorContent);

    const event = dispatchKeydownOn(line, router, { key: "v", ctrlKey: true });

    expect(execute).toHaveBeenCalledWith("edit.paste");
    expect(event.defaultPrevented).toBe(true);
  });

  it("still runs non-editor shortcuts from a text input", () => {
    const execute = vi.fn(async () => true);
    const router = createShortcutRouter({ definitions: createDefinitions(), execute });

    const input = document.createElement("input");
    document.body.appendChild(input);

    const event = dispatchKeydownOn(input, router, { key: "s", ctrlKey: true });

    expect(execute).toHaveBeenCalledWith("file.save");
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not swallow the key when canExecute reports the command as blocked", () => {
    const execute = vi.fn(async () => true);
    const router = createShortcutRouter({
      definitions: createDefinitions(),
      execute,
      canExecute: () => false
    });

    const event = dispatchKeydownOn(document.body, router, { key: "s", ctrlKey: true });

    expect(execute).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
