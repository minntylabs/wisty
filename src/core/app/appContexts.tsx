import { createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js";
import type { CommandRegistry, MenuSection } from "../commands/commandRegistry";

type CommandsContextValue = {
  sections: MenuSection[];
  registry: CommandRegistry;
  /**
   * Whether the app is busy with something the user must not act behind.
   *
   * The menu needs it because it is the same answer the command pipeline gives:
   * without it every item rendered as usual while a file was loading, saving or
   * converting, and clicking one did nothing at all.
   */
  interactionBlocked: Accessor<boolean>;
};

type MenuContextValue = {
  activeMenuId: Accessor<string | null>;
  onActiveMenuIdChange: (value: string | null) => void;
  menuPanelOpen: Accessor<boolean>;
  onMenuPanelOpenChange: (value: boolean) => void;
  onMenuCommandSelected: (commandId: string) => void;
  onRequestEditorFocus: () => void;
};

const CommandsContext = createContext<CommandsContextValue>();
const MenuContext = createContext<MenuContextValue>();

export const CommandsProvider = (props: ParentProps<{ value: CommandsContextValue }>): JSX.Element => (
  <CommandsContext.Provider value={props.value}>{props.children}</CommandsContext.Provider>
);

export const MenuProvider = (props: ParentProps<{ value: MenuContextValue }>): JSX.Element => (
  <MenuContext.Provider value={props.value}>{props.children}</MenuContext.Provider>
);

export const useCommandsContext = (): CommandsContextValue => {
  const context = useContext(CommandsContext);
  if (!context) {
    throw new Error("useCommandsContext must be used within a CommandsProvider");
  }
  return context;
};

export const useMenuContext = (): MenuContextValue => {
  const context = useContext(MenuContext);
  if (!context) {
    throw new Error("useMenuContext must be used within a MenuProvider");
  }
  return context;
};
