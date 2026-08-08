import { describe, expect, it, vi } from "vitest";
import { useGlobalKeyRouting } from "./useGlobalKeyRouting";

/**
 * Only the F5 suppression is covered here. The rest of this module is a
 * precedence chain over application state that is exercised through the app;
 * F5 is different because what it guards against is destructive, platform
 * specific, and invisible on the machine this is developed on.
 */
const createHarness = (overrides: Partial<Record<string, unknown>> = {}) => {
  const options = {
    fileLoading: () => false,
    requestCancelFileLoad: vi.fn(),
    fileSaving: () => false,
    requestCancelFileSave: vi.fn(),
    errorModalOpen: () => false,
    dismissErrorModal: vi.fn(),
    aboutOpen: () => false,
    addedWordsOpen: () => false,
    largeFileDialogOpen: () => false,
    confirmDiscardOpen: () => false,
    resolveConfirmDiscard: vi.fn(async () => {}),
    menuPanelOpen: () => false,
    activeMenuId: () => null,
    closeMenu: vi.fn(),
    openMenuByMnemonic: () => false,
    dispatchShortcut: () => false,
    executeCommand: vi.fn(async () => false),
    focusEditor: vi.fn(),
    ...overrides
  } as unknown as Parameters<typeof useGlobalKeyRouting>[0];

  return useGlobalKeyRouting(options);
};

const press = (key: string) => new KeyboardEvent("keydown", { key, cancelable: true });

describe("F5 never reaches the webview", () => {
  it("is suppressed even with nothing else going on", () => {
    // WebView2 enables browser accelerator keys by default, where F5 reloads
    // the page and takes unsaved edits with it. The editor's own F5 binding
    // only covers a focused editor; this covers every other focus.
    const { handleGlobalKeydown } = createHarness();
    const event = press("F5");
    handleGlobalKeydown(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("is suppressed while a dialog is open", () => {
    // The case the editor keymap cannot reach at all, and the one where a
    // reload would be most surprising.
    for (const open of ["errorModalOpen", "aboutOpen", "confirmDiscardOpen", "largeFileDialogOpen"]) {
      const { handleGlobalKeydown } = createHarness({ [open]: () => true });
      const event = press("F5");
      handleGlobalKeydown(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  // No test for the loading and saving states: those branches suppress every
  // key regardless, so an F5 assertion there would pass with this guard
  // deleted. It would look like coverage and be none.

  it("leaves other keys alone", () => {
    const { handleGlobalKeydown } = createHarness();
    for (const key of ["F4", "F6", "a", "Enter"]) {
      const event = press(key);
      handleGlobalKeydown(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });
});
