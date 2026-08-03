import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { useRememberedPosition } from "./useRememberedPosition";
import type { RememberedPosition } from "../settings/settingsTypes";

const POSITION: RememberedPosition = { topLine: 40, cursorLine: 42, cursorColumn: 7 };
const OTHER: RememberedPosition = { topLine: 1, cursorLine: 1, cursorColumn: 0 };

const setup = (options: { filePath?: string; stored?: Record<string, RememberedPosition> } = {}) => {
  let dispose = () => {};

  const [documentState, setDocumentState] = createStore({
    filePath: options.filePath ?? "/tmp/a.txt"
  });
  const [settingsState, setSettingsState] = createStore({
    rememberedPositions: options.stored ?? ({} as Record<string, RememberedPosition>)
  });

  const editor = {
    getViewPosition: vi.fn((): RememberedPosition | null => POSITION),
    setViewPosition: vi.fn()
  };

  // Object-form setters, matching the real store: the path form would merge
  // rather than replace, so a deletion would not take effect.
  const actions = {
    rememberPosition: vi.fn(async (filePath: string, position: RememberedPosition) => {
      setSettingsState({
        rememberedPositions: { ...settingsState.rememberedPositions, [filePath]: position }
      });
    }),
    forgetPosition: vi.fn(async (filePath: string) => {
      const { [filePath]: _removed, ...rest } = settingsState.rememberedPositions;
      setSettingsState({ rememberedPositions: rest });
    }),
    moveRememberedPosition: vi.fn(async () => {})
  };

  const controller = createRoot((disposeFn) => {
    dispose = disposeFn;
    return useRememberedPosition({
      editor,
      document: { state: documentState },
      settings: { state: settingsState, actions }
    });
  });

  return { controller, editor, actions, settingsState, setDocumentState, dispose };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("availability", () => {
  it("is unavailable for an untitled document, which has no path to key by", () => {
    const { controller, dispose } = setup({ filePath: "" });
    expect(controller.canRemember()).toBe(false);
    dispose();
  });

  it("is available once the document has a path", () => {
    const { controller, dispose } = setup();
    expect(controller.canRemember()).toBe(true);
    dispose();
  });

  it("reports whether the current file has a stored entry", () => {
    const { controller, dispose } = setup({ stored: { "/tmp/a.txt": POSITION } });
    expect(controller.isRemembered()).toBe(true);
    dispose();
  });
});

describe("toggling", () => {
  it("stores the current position straight away, so the menu check is truthful", async () => {
    const { controller, actions, dispose } = setup();
    await controller.toggle();
    expect(actions.rememberPosition).toHaveBeenCalledWith("/tmp/a.txt", POSITION);
    expect(controller.isRemembered()).toBe(true);
    dispose();
  });

  it("deletes the entry when toggled off", async () => {
    const { controller, actions, dispose } = setup({ stored: { "/tmp/a.txt": POSITION } });
    await controller.toggle();
    expect(actions.forgetPosition).toHaveBeenCalledWith("/tmp/a.txt");
    expect(controller.isRemembered()).toBe(false);
    dispose();
  });

  it("does nothing for an untitled document", async () => {
    const { controller, actions, dispose } = setup({ filePath: "" });
    await controller.toggle();
    expect(actions.rememberPosition).not.toHaveBeenCalled();
    dispose();
  });
});

describe("capture", () => {
  it("writes nothing for a file that has not opted in", async () => {
    const { controller, actions, dispose } = setup();
    await controller.capture();
    expect(actions.rememberPosition).not.toHaveBeenCalled();
    dispose();
  });

  it("writes the current position for a file that has", async () => {
    const { controller, actions, editor, dispose } = setup({ stored: { "/tmp/a.txt": OTHER } });
    await controller.capture();
    expect(editor.getViewPosition).toHaveBeenCalled();
    expect(actions.rememberPosition).toHaveBeenCalledWith("/tmp/a.txt", POSITION);
    dispose();
  });

  it("debounces scrolling into a single write once it settles", async () => {
    const { controller, actions, dispose } = setup({ stored: { "/tmp/a.txt": OTHER } });
    controller.scheduleCapture();
    controller.scheduleCapture();
    controller.scheduleCapture();
    expect(actions.rememberPosition).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(actions.rememberPosition).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("schedules nothing for a file that has not opted in", async () => {
    const { controller, actions, dispose } = setup();
    controller.scheduleCapture();
    await vi.advanceTimersByTimeAsync(5000);
    expect(actions.rememberPosition).not.toHaveBeenCalled();
    dispose();
  });

  it("an explicit capture cancels a pending one, so a file switch cannot misattribute it", async () => {
    const { controller, actions, setDocumentState, dispose } = setup({
      stored: { "/tmp/a.txt": OTHER }
    });
    controller.scheduleCapture();
    await controller.capture();
    expect(actions.rememberPosition).toHaveBeenCalledTimes(1);

    // Switching files must not let the earlier timer fire against the new path.
    setDocumentState({ filePath: "/tmp/b.txt" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(actions.rememberPosition).toHaveBeenCalledTimes(1);
    expect(actions.rememberPosition).toHaveBeenCalledWith("/tmp/a.txt", POSITION);
    dispose();
  });
});

describe("restore", () => {
  it("applies a stored position", () => {
    const { controller, editor, dispose } = setup({ stored: { "/tmp/a.txt": POSITION } });
    controller.restore("/tmp/a.txt");
    expect(editor.setViewPosition).toHaveBeenCalledWith(POSITION);
    dispose();
  });

  it("does nothing for a file with no stored position", () => {
    const { controller, editor, dispose } = setup();
    controller.restore("/tmp/a.txt");
    expect(editor.setViewPosition).not.toHaveBeenCalled();
    dispose();
  });
});
