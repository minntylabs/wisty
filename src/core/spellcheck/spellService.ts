import { invoke } from "@tauri-apps/api/core";

export type DictionaryInfo = {
  code: string;
  label: string;
};

/**
 * Thin wrapper over the hunspell Tauri commands with a per-word result cache so
 * repeated checks of the same word (common as the viewport is re-scanned) don't
 * cross the IPC boundary more than once.
 */
/**
 * How many distinct words to remember the verdict for.
 *
 * The cache exists to stop the same word crossing the IPC boundary each time
 * the viewport is re-scanned, which is a matter of the few thousand words on
 * screen and around them. Left unbounded it gained an entry for every distinct
 * word of every document opened, for the life of the process — the one thing
 * here that scales with the gigabyte files this editor is built to open.
 *
 * Oldest-first eviction: what has just been asked about is what the viewport
 * holds, and what has not been asked about in fifty thousand words is not on
 * screen any more.
 */
const MAX_CACHED_WORDS = 50_000;

export const createSpellService = () => {
  const correctnessCache = new Map<string, boolean>();

  const remember = (word: string, correct: boolean) => {
    // Re-inserted so a word still being looked at moves to the newest end, and
    // Map iteration order does the rest.
    correctnessCache.delete(word);
    correctnessCache.set(word, correct);
    while (correctnessCache.size > MAX_CACHED_WORDS) {
      const oldest = correctnessCache.keys().next();
      if (oldest.done) {
        return;
      }
      correctnessCache.delete(oldest.value);
    }
  };

  const listDictionaries = (): Promise<DictionaryInfo[]> =>
    invoke<DictionaryInfo[]>("spell_list_dictionaries");

  const loadDictionary = async (code: string): Promise<boolean> => {
    const loaded = await invoke<boolean>("spell_load_dictionary", { code });
    correctnessCache.clear();
    return loaded;
  };

  /** Returns the subset of `words` that are misspelled. */
  const findMisspelled = async (words: string[]): Promise<Set<string>> => {
    const unresolved = [...new Set(words.filter((word) => !correctnessCache.has(word)))];

    if (unresolved.length > 0) {
      const results = await invoke<boolean[]>("spell_check_words", { words: unresolved });
      unresolved.forEach((word, index) => {
        remember(word, results[index] ?? true);
      });
    }

    const misspelled = new Set<string>();
    for (const word of words) {
      if (correctnessCache.get(word) === false) {
        misspelled.add(word);
      }
    }
    return misspelled;
  };

  const suggest = (word: string): Promise<string[]> =>
    invoke<string[]>("spell_suggest", { word });

  const addWord = async (word: string): Promise<void> => {
    await invoke("spell_add_word", { word });
    remember(word, true);
  };

  const ignoreWord = async (word: string): Promise<void> => {
    await invoke("spell_ignore_word", { word });
    remember(word, true);
  };

  const listAddedWords = (): Promise<string[]> =>
    invoke<string[]>("spell_list_added_words");

  const removeWord = async (word: string): Promise<void> => {
    await invoke("spell_remove_word", { word });
    correctnessCache.clear();
  };

  const clearCache = () => correctnessCache.clear();

  return {
    listDictionaries,
    loadDictionary,
    findMisspelled,
    suggest,
    addWord,
    ignoreWord,
    listAddedWords,
    removeWord,
    clearCache
  };
};

export type SpellService = ReturnType<typeof createSpellService>;
