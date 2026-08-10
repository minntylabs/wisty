/**
 * What a menu says about the state of the things it toggles.
 *
 * The accessible half and the visible half are separate mechanisms, and fixing
 * one is how the other went missing: `aria-checked` has no default rendering,
 * so an item can be correctly announced as checked and show nothing at all.
 * Both are asserted here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { MenuBar } from "./MenuBar";
import { CommandsProvider, MenuProvider } from "../core/app/appContexts";
import { createCommandRegistry, type MenuSection } from "../core/commands/commandRegistry";

// jsdom has no ResizeObserver, and the menu's overflow hint constructs one.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", StubResizeObserver);

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

const showMenu = (checkedInitially: boolean) => {
  const [checked, setChecked] = createSignal(checkedInitially);
  const definitions = [
    {
      id: "view.wrap",
      label: "Word Wrap",
      shortcut: "Alt+Z",
      run: () => {},
      checked: () => checked()
    },
    { id: "file.save", label: "Save", shortcut: "Ctrl+S", run: () => {} }
  ];
  const sections: MenuSection[] = [
    {
      id: "view",
      label: "View",
      items: [
        { type: "command", commandId: "view.wrap" },
        { type: "command", commandId: "file.save" }
      ]
    }
  ];
  const registry = createCommandRegistry(definitions);
  const [menuPanelOpen, setMenuPanelOpen] = createSignal(true);
  const [activeMenuId, setActiveMenuId] = createSignal<string | null>("view");

  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <CommandsProvider value={{ sections, registry, interactionBlocked: () => false }}>
        <MenuProvider
          value={{
            activeMenuId,
            onActiveMenuIdChange: setActiveMenuId,
            menuPanelOpen,
            onMenuPanelOpenChange: setMenuPanelOpen,
            onMenuCommandSelected: vi.fn(),
            onRequestEditorFocus: vi.fn()
          }}
        >
          <MenuBar />
        </MenuProvider>
      </CommandsProvider>
    ),
    host
  );
  return { setChecked };
};

/** The item whose label reads `label`, wherever it was portalled to. */
const itemNamed = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(".menu-item")].find(
    (item) => item.querySelector(".menu-item-label")?.textContent === label
  );

describe("showing which settings are on", () => {
  it("puts a tick on a checked item", () => {
    showMenu(true);
    const item = itemNamed("Word Wrap");
    expect(item, "the menu did not render").toBeDefined();
    expect(item?.querySelector(".menu-item-check")?.textContent).toBe("✓");
  });

  it("leaves the tick column empty when it is off", () => {
    showMenu(false);
    expect(itemNamed("Word Wrap")?.querySelector(".menu-item-check")?.textContent).toBe("");
  });

  it("reserves the column on items that cannot be checked, so labels line up", () => {
    showMenu(true);
    expect(itemNamed("Save")?.querySelector(".menu-item-check")).not.toBeNull();
  });

  it("hides the tick from assistive technology, which reads the role instead", () => {
    showMenu(true);
    const item = itemNamed("Word Wrap");
    expect(item?.querySelector(".menu-item-check")?.getAttribute("aria-hidden")).toBe("true");
    expect(item?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(item?.getAttribute("aria-checked")).toBe("true");
  });

  it("says nothing about checkedness for an item that has no such state", () => {
    showMenu(true);
    expect(itemNamed("Save")?.getAttribute("role")).not.toBe("menuitemcheckbox");
    expect(itemNamed("Save")?.hasAttribute("aria-checked")).toBe(false);
  });

  it("follows the setting while the menu is open", () => {
    // The tick is read inside the JSX expression, so it tracks. Computed once
    // into a variable it would freeze at whatever it was when the menu opened.
    const { setChecked } = showMenu(false);
    expect(itemNamed("Word Wrap")?.querySelector(".menu-item-check")?.textContent).toBe("");

    setChecked(true);

    expect(itemNamed("Word Wrap")?.querySelector(".menu-item-check")?.textContent).toBe("✓");
    expect(itemNamed("Word Wrap")?.getAttribute("aria-checked")).toBe("true");
  });
});
