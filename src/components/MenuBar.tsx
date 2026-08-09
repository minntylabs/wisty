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

const commandLabel = (definition: CommandDefinition) => {
  const label = definition.getLabel ? definition.getLabel() : definition.label;
  if (!definition.checked) {
    return label;
  }
  return `${label}${definition.checked() ? " ✓" : ""}`;
};

export const MenuBar = () => {
  const commands = useCommandsContext();
  const menu = useMenuContext();
  let closeReason: "none" | "escape" | "trigger-toggle" = "none";

  const renderItem = (item: MenuItem): JSX.Element => {
    if (item.visible && !item.visible()) {
      return null;
    }
    if (item.type === "separator") {
      return <MenubarSeparator class="menu-separator" />;
    }
    if (item.type === "submenu") {
      return (
        <MenubarSub>
          <MenubarSubTrigger class="menu-item menu-submenu-trigger">
            <span class="menu-item-label">{item.getLabel ? item.getLabel() : item.label}</span>
            <span class="menu-item-shortcut menu-submenu-arrow">›</span>
          </MenubarSubTrigger>
          <MenubarPortal>
            <MenubarSubContent class="menu-popover">
              <ScrollArea>
                <For each={item.items()}>{(child) => renderItem(child)}</For>
              </ScrollArea>
            </MenubarSubContent>
          </MenubarPortal>
        </MenubarSub>
      );
    }

    const command = commands.registry.get(item.commandId);
    if (!command) {
      return null;
    }
    const enabled = menuItemEnabled(command, commands.interactionBlocked());

    return (
      <MenubarItem
        class="menu-item"
        disabled={!enabled}
        onSelect={() => {
          menu.onMenuCommandSelected(command.id);
        }}
      >
        <span class="menu-item-label">{commandLabel(command)}</span>
        <Show when={command.shortcut}>
          <span class="menu-item-shortcut">{command.shortcut}</span>
        </Show>
      </MenubarItem>
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
                    {(item) => renderItem(item)}
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
