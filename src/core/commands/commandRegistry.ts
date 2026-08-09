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

/**
 * Where a command's failure goes.
 *
 * Both the ways a command is run — a menu selection and a keyboard shortcut —
 * discard the promise, so without this a command that rejects was an unhandled
 * rejection in the console and nothing else on screen. Most commands report
 * their own failures, but not all: the spelling-language items call the settings
 * actions directly, so a failed settings write meant a menu item that appeared
 * to do nothing at all.
 */
export type CommandErrorReporter = (commandId: string, error: unknown) => void;

export const createCommandRegistry = (
  definitions: CommandDefinition[],
  onError?: CommandErrorReporter
): CommandRegistry => {
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
    try {
      await command.run();
    } catch (error) {
      // Reported rather than rethrown: the callers cannot act on it, and both
      // of them discard the promise, so rethrowing only reaches the console.
      onError?.(id, error);
      return false;
    }
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

