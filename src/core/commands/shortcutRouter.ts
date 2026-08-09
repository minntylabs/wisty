import type { CommandDefinition } from "./commandRegistry";

type ShortcutBinding = {
  commandId: string;
  key: string;
  requiresShift: boolean;
  requiresMod: boolean;
  requiresAlt: boolean;
  skipWhenTextInputFocused: boolean;
};

type ShortcutRouterDeps = {
  definitions: CommandDefinition[];
  execute: (commandId: string) => Promise<boolean>;
  canExecute?: (commandId: string) => boolean;
};

/**
 * True when the key event originates from a text field outside the editor
 * document (e.g. the find/replace panel inputs), where native clipboard and
 * undo handling must win over the editor-wide commands.
 */
const isTextInputOutsideEditor = (event: KeyboardEvent): boolean => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest(".cm-content")) {
    return false;
  }
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target.isContentEditable;
};

const parseShortcut = (commandId: string, shortcut: string): ShortcutBinding | null => {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return null;
  }

  const key = parts[parts.length - 1]?.toLowerCase();
  if (!key) {
    return null;
  }

  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));
  const requiresShift = modifiers.has("shift");
  const requiresMod = modifiers.has("cmd") || modifiers.has("ctrl") || modifiers.has("mod");
  const requiresAlt = modifiers.has("alt");

  return {
    commandId,
    key,
    requiresShift,
    requiresMod,
    requiresAlt,
    skipWhenTextInputFocused: false
  };
};

const normalizeEventKey = (event: KeyboardEvent): string => {
  return event.key.toLowerCase();
};

const matchesShortcut = (event: KeyboardEvent, binding: ShortcutBinding): boolean => {
  if (binding.requiresAlt !== event.altKey) {
    return false;
  }

  const hasMod = event.ctrlKey || event.metaKey;
  if (binding.requiresMod !== hasMod) {
    return false;
  }

  if (binding.requiresShift !== event.shiftKey) {
    return false;
  }

  return normalizeEventKey(event) === binding.key;
};

/**
 * Commands whose shortcut is already claimed by an earlier one.
 *
 * Only the first binding for a chord can ever fire, so a collision means a menu
 * item printing a shortcut beside itself that does nothing. Nothing said so:
 * the duplicate was skipped in silence, and the only way to find out was to
 * press the key. Exported so a test can assert the real command set has none.
 */
export const duplicateShortcuts = (definitions: readonly CommandDefinition[]): string[] => {
  const claimedBy = new Map<string, string>();
  const duplicates: string[] = [];
  for (const definition of definitions) {
    if (!definition.shortcut) {
      continue;
    }
    const parsed = parseShortcut(definition.id, definition.shortcut);
    if (!parsed) {
      continue;
    }
    const chord = chordKey(parsed);
    const claimant = claimedBy.get(chord);
    if (claimant) {
      duplicates.push(`${definition.shortcut} is claimed by ${claimant} and ${definition.id}`);
      continue;
    }
    claimedBy.set(chord, definition.id);
  }
  return duplicates;
};

const chordKey = (binding: ShortcutBinding) =>
  `${binding.requiresMod ? "mod" : "plain"}:${binding.requiresShift ? "shift" : "plain"}:${binding.requiresAlt ? "alt" : "plain"}:${binding.key}`;

export const createShortcutRouter = (deps: ShortcutRouterDeps) => {
  const bindings: ShortcutBinding[] = [];
  const seenShortcuts = new Set<string>();

  for (const definition of deps.definitions) {
    if (!definition.shortcut) {
      continue;
    }

    const parsed = parseShortcut(definition.id, definition.shortcut);
    if (!parsed) {
      continue;
    }

    const dedupeKey = chordKey(parsed);
    if (seenShortcuts.has(dedupeKey)) {
      continue;
    }

    seenShortcuts.add(dedupeKey);
    parsed.skipWhenTextInputFocused = Boolean(definition.skipWhenTextInputFocused);
    bindings.push(parsed);
  }

  const dispatch = (event: KeyboardEvent): boolean => {
    for (const binding of bindings) {
      if (!matchesShortcut(event, binding)) {
        continue;
      }
      if (binding.skipWhenTextInputFocused && isTextInputOutsideEditor(event)) {
        return false;
      }
      if (deps.canExecute && !deps.canExecute(binding.commandId)) {
        // Deliberately not prevented: an unavailable command does not claim the
        // key, so whatever would normally handle it still can. See the test
        // that pins this.
        return false;
      }
      event.preventDefault();
      void deps.execute(binding.commandId);
      return true;
    }
    return false;
  };

  return {
    dispatch
  };
};
