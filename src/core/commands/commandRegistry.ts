export type CommandDefinition = {
  id: string;
  label: string;
  getLabel?: () => string;
  shortcut?: string;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
  checked?: () => boolean;
  refocusEditorOnMenuSelect?: boolean;
  /**
   * The command edits the editor document or clipboard, so its shortcut must
   * yield to native handling while a text input outside the editor (e.g. the
   * search panel) has focus.
   */
  skipWhenTextInputFocused?: boolean;
};

export type MenuItem = {
  type: "command";
  commandId: string;
  visible?: () => boolean;
} | {
  type: "separator";
  visible?: () => boolean;
} | {
  type: "submenu";
  id: string;
  label: string;
  getLabel?: () => string;
  visible?: () => boolean;
  items: () => MenuItem[];
};

export type MenuSection = {
  id: string;
  label: string;
  items: MenuItem[];
};

export type CommandRegistry = {
  definitions: CommandDefinition[];
  get: (id: string) => CommandDefinition | undefined;
  canExecute: (id: string) => boolean;
  execute: (id: string) => Promise<boolean>;
  register: (definition: CommandDefinition) => void;
};

export const createCommandRegistry = (definitions: CommandDefinition[]): CommandRegistry => {
  const commandMap = new Map(definitions.map((definition) => [definition.id, definition]));

  const get = (id: string) => commandMap.get(id);

  /** Registers (or replaces) a command at runtime, e.g. dynamically-discovered items. */
  const register = (definition: CommandDefinition) => {
    commandMap.set(definition.id, definition);
  };

  const canExecute = (id: string) => {
    const command = get(id);
    if (!command) {
      return false;
    }
    return command.enabled ? command.enabled() : true;
  };

  const execute = async (id: string) => {
    if (!canExecute(id)) {
      return false;
    }
    const command = get(id);
    if (!command) {
      return false;
    }
    await command.run();
    return true;
  };

  return {
    definitions,
    get,
    canExecute,
    execute,
    register
  };
};

/**
 * Whether a menu item should be offered.
 *
 * Both halves of it: what the command says about itself, and whether anything
 * can be run at all. Only the first was consulted, so every item rendered as
 * usual while a file was loading, saving or converting — and clicking one did
 * nothing, because the pipeline that runs commands consults the second.
 */
export const menuItemEnabled = (
  command: Pick<CommandDefinition, "enabled">,
  interactionBlocked: boolean
): boolean => (command.enabled ? command.enabled() : true) && !interactionBlocked;

