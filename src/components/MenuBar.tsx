import { For, JSX, Show, createSignal, onCleanup } from "solid-js";
import {
  Root as MenubarRoot,
  Menu as MenubarMenu,
  Trigger as MenubarTrigger,
  Portal as MenubarPortal,
  Content as MenubarContent,
  Item as MenubarItem,
  Separator as MenubarSeparator,
  Sub as MenubarSub,
  SubTrigger as MenubarSubTrigger,
  SubContent as MenubarSubContent
} from "@kobalte/core/menubar";
import { useCommandsContext, useMenuContext } from "../core/app/appContexts";
import { CommandDefinition, MenuItem, menuItemEnabled } from "../core/commands/commandRegistry";

/** Tracks whether a scrollable element has content hidden below its visible edge. */
const createScrollOverflow = () => {
  const [hasMore, setHasMore] = createSignal(false);

  const attach = (el: HTMLElement) => {
    const update = () => setHasMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
    update();
    el.addEventListener("scroll", update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    onCleanup(() => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    });
  };

  return { hasMore, attach };
};

/** Wraps menu items in a scrollable area with a "More…" hint when items overflow it. */
const ScrollArea = (props: { children: JSX.Element }) => {
  const overflow = createScrollOverflow();
  return (
    <>
      <div class="menu-scroll-area" ref={(el) => overflow.attach(el)}>
        {props.children}
      </div>
      <Show when={overflow.hasMore()}>
        <div class="menu-scroll-more" aria-hidden="true">More…</div>
      </Show>
    </>
  );
};

const commandLabel = (definition: CommandDefinition) =>
  definition.getLabel ? definition.getLabel() : definition.label;

/**
 * The tick column.
 *
 * `aria-checked` on the item says the state to a screen reader and to nothing
 * else — there is no default rendering for it — so a sighted user was left with
 * no indication of any toggle's state anywhere in the menus. This is the other
 * half of that, hidden from assistive technology because the role already
 * carries it and hearing "tick" after "checked" is noise.
 *
 * Rendered for every item of a menu that has anything checkable in it, so its
 * labels line up with each other rather than stepping in and out by the width
 * of a tick — and for no item of a menu that has not, where the column would be
 * an indent that never means anything.
 */
const CheckGutter = (props: { checked?: () => boolean }) => (
  <span class="menu-item-check" aria-hidden="true">
    {props.checked?.() ? "✓" : ""}
  </span>
);

export const MenuBar = () => {
  const commands = useCommandsContext();
  const menu = useMenuContext();
  let closeReason: "none" | "escape" | "trigger-toggle" = "none";

  /**
   * Whether this menu needs a tick column at all.
   *
   * Its own items only: a submenu is a separate popover and answers this for
   * itself, and its trigger in the parent is never checked. Hidden items do not
   * count — a column reserved for something that is not there is the indent
   * this is meant to avoid.
   */
  const hasCheckableItem = (items: readonly MenuItem[]) =>
    items.some((item) => {
      if (item.type !== "command") {
        return false;
      }
      if (item.visible && !item.visible()) {
        return false;
      }
      return Boolean(commands.registry.get(item.commandId)?.checked);
    });

  const renderItem = (item: MenuItem, showChecks: () => boolean): JSX.Element => {
    const visible = () => !item.visible || item.visible();
    if (item.type === "separator") {
      return <Show when={visible()}><MenubarSeparator class="menu-separator" /></Show>;
    }
    if (item.type === "submenu") {
      return (
        <Show when={visible()}>
          <MenubarSub>
            <MenubarSubTrigger class="menu-item menu-submenu-trigger">
              <Show when={showChecks()}>
                <CheckGutter />
              </Show>
              <span class="menu-item-label">{item.getLabel ? item.getLabel() : item.label}</span>
              <span class="menu-item-shortcut menu-submenu-arrow">›</span>
            </MenubarSubTrigger>
            <MenubarPortal>
              <MenubarSubContent class="menu-popover">
                <ScrollArea>
                  <For each={item.items()}>
                    {(child) => renderItem(child, () => hasCheckableItem(item.items()))}
                  </For>
                </ScrollArea>
              </MenubarSubContent>
            </MenubarPortal>
          </MenubarSub>
        </Show>
      );
    }

    const command = commands.registry.get(item.commandId);
    if (!command) {
      return null;
    }
    return (
      <Show when={visible()}>
        <MenubarItem
          class="menu-item"
          role={command.checked ? "menuitemcheckbox" : undefined}
          aria-checked={command.checked ? command.checked() : undefined}
          disabled={!menuItemEnabled(command, commands.interactionBlocked())}
          onSelect={() => {
            menu.onMenuCommandSelected(command.id);
          }}
        >
          <Show when={showChecks()}>
            <CheckGutter checked={command.checked} />
          </Show>
          <span class="menu-item-label">{commandLabel(command)}</span>
          <Show when={command.shortcut}>
            <span class="menu-item-shortcut">{command.shortcut}</span>
          </Show>
        </MenubarItem>
      </Show>
    );
  };

  return (
    <MenubarRoot
      class="menu-bar"
      role="menubar"
      aria-label="Application menu"
      value={menu.activeMenuId() ?? undefined}
      onValueChange={(value) => {
        menu.onActiveMenuIdChange(value ?? null);
        if (value == null) {
          menu.onMenuPanelOpenChange(false);
        }
      }}
      autoFocusMenu={menu.menuPanelOpen()}
      onAutoFocusMenuChange={(isOpen) => {
        const nextOpen = Boolean(isOpen);
        menu.onMenuPanelOpenChange(nextOpen);
        if (!nextOpen) {
          menu.onActiveMenuIdChange(null);
        }
      }}
      loop
    >
      <For each={commands.sections}>
        {(section) => (
          <MenubarMenu value={section.id}>
            <MenubarTrigger
              class="menu-trigger"
              onPointerDown={() => {
                if (menu.menuPanelOpen() && menu.activeMenuId() === section.id) {
                  closeReason = "trigger-toggle";
                }
              }}
            >
              {section.label}
            </MenubarTrigger>
            <MenubarPortal>
              <MenubarContent
                class="menu-popover"
                onEscapeKeyDown={() => {
                  closeReason = "escape";
                }}
                onCloseAutoFocus={(event) => {
                  if (closeReason === "escape" || closeReason === "trigger-toggle") {
                    closeReason = "none";
                    event.preventDefault();
                    menu.onActiveMenuIdChange(null);
                    menu.onMenuPanelOpenChange(false);
                    menu.onRequestEditorFocus();
                    return;
                  }
                  closeReason = "none";
                }}
              >
                <ScrollArea>
                  <For each={section.items}>
                    {(item) => renderItem(item, () => hasCheckableItem(section.items))}
                  </For>
                </ScrollArea>
              </MenubarContent>
            </MenubarPortal>
          </MenubarMenu>
        )}
      </For>
    </MenubarRoot>
  );
};
