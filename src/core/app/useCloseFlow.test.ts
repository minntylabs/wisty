import { describe, it, expect, vi } from "vitest";
import { createSignal } from "solid-js";
import { useCloseFlow } from "./useCloseFlow";
import type { CloseRequestEvent } from "./contracts";

const createHarness = (options: { dirty?: boolean; closeWindow?: () => Promise<void> } = {}) => {
  const [isDirty, setIsDirty] = createSignal(options.dirty ?? true);
  const closeWindow = vi.fn(options.closeWindow ?? (async () => {}));
  const focusEditor = vi.fn();
  const showError = vi.fn(async () => {});
  const flow = useCloseFlow({
    isDirty,
    closeWindow,
    focusEditor,
    errors: { showError }
  });
  return { flow, closeWindow, focusEditor, showError, setIsDirty };
};

/** Stands in for Tauri's close event, which the flow only ever vetoes. */
const closeEvent = (): CloseRequestEvent & { prevented: boolean } => {
  const event = {
    prevented: false,
    preventDefault() {
      event.prevented = true;
    }
  };
  return event as CloseRequestEvent & { prevented: boolean };
};

describe("closing the window", () => {
  it("closes straight away when there is nothing to lose", async () => {
    const h = createHarness({ dirty: false });
    await h.flow.requestClose();
    expect(h.closeWindow).toHaveBeenCalledOnce();
    expect(h.flow.confirmDiscardOpen()).toBe(false);
  });

  it("asks before closing a dirty document", async () => {
    const h = createHarness({ dirty: true });
    await h.flow.requestClose();
    expect(h.closeWindow).not.toHaveBeenCalled();
    expect(h.flow.confirmDiscardOpen()).toBe(true);
    expect(h.flow.closeFlowState()).toBe("awaiting-discard");
  });

  it("lets the second close through once the user has said discard", async () => {
    // The flow closes the window itself, and Tauri then reports the close it
    // asked for. That one must not be questioned again.
    const h = createHarness({ dirty: true });
    await h.flow.requestClose();
    await h.flow.resolveConfirmDiscard(true);
    expect(h.closeWindow).toHaveBeenCalledOnce();

    const event = closeEvent();
    h.flow.handleWindowCloseRequested(event);
    expect(event.prevented).toBe(false);
  });

  /**
   * The bug this guards: force-closing was set before closeWindow was awaited
   * and never taken back if it failed. The window stayed open, still dirty, and
   * the next close was read as one the user had already confirmed.
   */
  it("still asks next time when the close itself fails", async () => {
    const h = createHarness({
      dirty: true,
      closeWindow: async () => {
        throw new Error("the window would not close");
      }
    });

    await h.flow.requestClose();
    await h.flow.resolveConfirmDiscard(true);
    expect(h.showError).toHaveBeenCalled();
    expect(h.flow.closeFlowState()).not.toBe("force-closing");

    const event = closeEvent();
    h.flow.handleWindowCloseRequested(event);
    expect(event.prevented).toBe(true);
    expect(h.flow.confirmDiscardOpen()).toBe(true);
  });
});

describe("one question at a time", () => {
  /**
   * The prompt names no action, so whichever is pending is the one "discard"
   * answers. Overwriting it ran something the user was never asked about and
   * dropped what they were.
   */
  it("keeps the first action when a second is offered", async () => {
    const h = createHarness({ dirty: true });
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    await h.flow.runOrConfirmDiscard(first);
    await h.flow.runOrConfirmDiscard(second);
    await h.flow.resolveConfirmDiscard(true);

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("does not let a close request replace the pending action", async () => {
    const h = createHarness({ dirty: true });
    const opening = vi.fn(async () => {});

    await h.flow.runOrConfirmDiscard(opening);
    await h.flow.requestClose();
    await h.flow.resolveConfirmDiscard(true);

    expect(opening).toHaveBeenCalledOnce();
    expect(h.closeWindow).not.toHaveBeenCalled();
  });

  it("vetoes a close that arrives while another question is up", async () => {
    // Answering by destroying the window is the one outcome that cannot be
    // undone, so the close is refused even though the question stays as it was.
    const h = createHarness({ dirty: true });
    await h.flow.runOrConfirmDiscard(vi.fn(async () => {}));

    const event = closeEvent();
    h.flow.handleWindowCloseRequested(event);

    expect(event.prevented).toBe(true);
    expect(h.flow.confirmDiscardOpen()).toBe(true);
  });

  it("runs the action immediately when the document is clean", async () => {
    const h = createHarness({ dirty: false });
    const action = vi.fn(async () => {});
    await h.flow.runOrConfirmDiscard(action);
    expect(action).toHaveBeenCalledOnce();
    expect(h.flow.confirmDiscardOpen()).toBe(false);
  });

  it("drops the action and clears the close intent on cancel", async () => {
    const h = createHarness({ dirty: true });
    const action = vi.fn(async () => {});
    await h.flow.runOrConfirmDiscard(action);
    await h.flow.resolveConfirmDiscard(false);

    expect(action).not.toHaveBeenCalled();
    expect(h.flow.confirmDiscardOpen()).toBe(false);
    expect(h.flow.closeFlowState()).toBe("idle");
    expect(h.focusEditor).toHaveBeenCalled();
  });
});
