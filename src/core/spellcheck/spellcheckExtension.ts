import { Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { SpellService } from "./spellService";

/** Matches words (Unicode letters), allowing internal apostrophes: "don't", "it's". */
const WORD_PATTERN = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

const SCAN_DEBOUNCE_MS = 250;

const misspelledMark = Decoration.mark({ class: "cm-misspelled" });

/** Replaces the whole decoration set for the visible viewport. */
const setMisspelledEffect = StateEffect.define<DecorationSet>();

/** Forces the view plugin to re-scan even if the viewport is unchanged. */
export const requestSpellRescan = StateEffect.define<null>();

const misspelledField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setMisspelledEffect)) {
        next = effect.value;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

type WordOccurrence = {
  from: number;
  to: number;
  word: string;
};

const collectViewportWords = (view: EditorView): WordOccurrence[] => {
  const occurrences: WordOccurrence[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const match of text.matchAll(WORD_PATTERN)) {
      if (match.index === undefined) {
        continue;
      }
      const start = from + match.index;
      occurrences.push({ from: start, to: start + match[0].length, word: match[0] });
    }
  }
  return occurrences;
};

const buildDecorations = (occurrences: WordOccurrence[], misspelled: Set<string>): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  for (const occurrence of occurrences) {
    if (misspelled.has(occurrence.word)) {
      builder.add(occurrence.from, occurrence.to, misspelledMark);
    }
  }
  return builder.finish();
};

const createScanPlugin = (spellService: SpellService) =>
  ViewPlugin.fromClass(
    class {
      private timer: number | undefined;
      private generation = 0;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate) {
        const forced = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(requestSpellRescan))
        );
        if (forced || update.docChanged || update.viewportChanged) {
          this.schedule();
        }
      }

      private schedule() {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.scan(), SCAN_DEBOUNCE_MS);
      }

      private async scan() {
        const generation = ++this.generation;
        const occurrences = collectViewportWords(this.view);
        let misspelled: Set<string>;
        try {
          misspelled = await spellService.findMisspelled(occurrences.map((entry) => entry.word));
        } catch {
          return;
        }

        // Discard if a newer scan superseded this one (e.g. the doc changed).
        if (this.destroyed || generation !== this.generation) {
          return;
        }
        this.view.dispatch({ effects: setMisspelledEffect.of(buildDecorations(occurrences, misspelled)) });
      }

      destroy() {
        this.destroyed = true;
        this.generation += 1;
        window.clearTimeout(this.timer);
      }
    }
  );

/** Finds the misspelled word range covering `pos`, if any. */
const misspelledWordAt = (view: EditorView, pos: number): WordOccurrence | null => {
  let found: WordOccurrence | null = null;
  view.state.field(misspelledField).between(pos, pos, (from, to) => {
    if (from <= pos && pos <= to) {
      found = { from, to, word: view.state.doc.sliceString(from, to) };
      return false;
    }
    return undefined;
  });
  return found;
};

const createContextMenuHandler = (
  spellService: SpellService,
  onError?: (error: unknown) => void
) => {
  let activeMenu: HTMLElement | undefined;

  const closeMenu = () => {
    if (!activeMenu) {
      return;
    }
    activeMenu.remove();
    activeMenu = undefined;
    document.removeEventListener("mousedown", onOutsideInteraction, true);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("blur", closeMenu);
  };

  const onOutsideInteraction = (event: MouseEvent) => {
    if (activeMenu && !activeMenu.contains(event.target as Node)) {
      closeMenu();
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeMenu();
    }
  };

  const rescan = (view: EditorView) => {
    view.dispatch({ effects: requestSpellRescan.of(null) });
  };

  const openMenu = async (view: EditorView, target: WordOccurrence, clientX: number, clientY: number) => {
    closeMenu();

    const menu = document.createElement("div");
    menu.className = "cm-spell-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    const addItem = (label: string, action: () => void, extraClass = "") => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `cm-spell-menu-item${extraClass ? ` ${extraClass}` : ""}`;
      item.textContent = label;
      item.addEventListener("click", () => {
        closeMenu();
        action();
        view.focus();
      });
      menu.appendChild(item);
    };

    const addSeparator = () => {
      const separator = document.createElement("div");
      separator.className = "cm-spell-menu-separator";
      menu.appendChild(separator);
    };

    const loading = document.createElement("div");
    loading.className = "cm-spell-menu-note";
    loading.textContent = "Checking…";
    menu.appendChild(loading);

    document.body.appendChild(menu);
    activeMenu = menu;
    document.addEventListener("mousedown", onOutsideInteraction, true);
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("blur", closeMenu);

    let suggestions: string[];
    try {
      suggestions = await spellService.suggest(target.word);
    } catch (error) {
      if (activeMenu === menu) {
        closeMenu();
      }
      onError?.(error);
      return;
    }
    if (activeMenu !== menu) {
      return;
    }

    menu.replaceChildren();

    if (suggestions.length === 0) {
      const note = document.createElement("div");
      note.className = "cm-spell-menu-note";
      note.textContent = "No suggestions";
      menu.appendChild(note);
    } else {
      for (const suggestion of suggestions.slice(0, 8)) {
        addItem(suggestion, () => {
          view.dispatch({
            changes: { from: target.from, to: target.to, insert: suggestion },
            userEvent: "input.replace"
          });
        }, "cm-spell-menu-suggestion");
      }
    }

    addSeparator();
    // Failures are reported rather than dropped: adding a word writes a file,
    // and a read-only config directory used to leave the menu closing, the word
    // still underlined and nothing said anywhere.
    addItem("Add to Dictionary", () => {
      void spellService
        .addWord(target.word)
        .then(() => rescan(view))
        .catch((error: unknown) => onError?.(error));
    });
    addItem("Ignore All", () => {
      void spellService
        .ignoreWord(target.word)
        .then(() => rescan(view))
        .catch((error: unknown) => onError?.(error));
    });

    // Keep the menu within the viewport.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
    }
  };

  const domHandler = EditorView.domEventHandlers({
    contextmenu(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) {
        return false;
      }
      const target = misspelledWordAt(view, pos);
      if (!target) {
        return false;
      }
      event.preventDefault();
      void openMenu(view, target, event.clientX, event.clientY);
      return true;
    }
  });

  const cleanup = EditorView.updateListener.of((update) => {
    if (update.docChanged && activeMenu) {
      closeMenu();
    }
  });

  return [domHandler, cleanup];
};

const spellTheme = EditorView.baseTheme({
  ".cm-misspelled": {
    textDecoration: "underline wavy #dc2626",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "2px"
  }
});

/**
 * Builds the spell-check extension bundle backed by the given service.
 *
 * `onError` receives failures from the context menu's own actions, which write
 * to disk and so can fail for reasons the user can act on.
 */
export const createSpellcheckExtension = (
  spellService: SpellService,
  onError?: (error: unknown) => void
): Extension => [
  misspelledField,
  createScanPlugin(spellService),
  createContextMenuHandler(spellService, onError),
  spellTheme
];
