/**
 * The game's list of phrases Generica knows, from `phrases.txt`.
 *
 * The game's checker writes the file, so Wisty offers exactly what the game
 * accepts. Format: `[section]` headings, then one entry per line; an entry is
 * the phrase, then a tab and its explanation (the explanation is optional).
 * Lines starting `#` are notes.
 */

export type Phrase = {
  text: string;
  info: string;
};

export type Phrases = Record<string, Phrase[]>;

export const parsePhrases = (text: string): Phrases => {
  const sections: Phrases = {};
  let current: Phrase[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    const heading = /^\[([^\]]+)\]$/.exec(line.trim());
    if (heading) {
      current = [];
      sections[heading[1]] = current;
      continue;
    }
    if (!current) {
      continue;
    }
    const tab = line.indexOf("\t");
    current.push(
      tab < 0
        ? { text: line.trim(), info: "" }
        : { text: line.slice(0, tab).trim(), info: line.slice(tab + 1).trim() }
    );
  }
  return sections;
};

export const phrasesIn = (phrases: Phrases, section: string): Phrase[] => phrases[section] ?? [];
