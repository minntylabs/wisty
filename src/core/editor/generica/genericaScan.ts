/**
 * Finds the blocks of a Generica file: what each `==` heading introduces.
 *
 * A heading alone says little: `== welcome` may be a section, a task or a
 * conversation. The lines below tell (a `send:` line makes a conversation, a
 * `done when:` or `marker:` line a task). Pure functions over an array of
 * lines, so they are testable without the editor.
 */

export type BlockKind = "conversation" | "section" | "task" | "person" | "item" | "place";

export type Block = {
  kind: BlockKind;
  name: string;
  /** Zero-based line of the `==` heading. */
  heading: number;
  /** Zero-based last line of the block (before the next heading). */
  last: number;
  /** For a section, the conversation it belongs to. */
  conversation: string;
};

const NOTE = /^\s*#/;
const TASK_LINE = /^\s*(marker|done when|fails when):/;
const DECLARED = new Set(["person", "item", "place"]);

export const isHeading = (line: string): boolean => line.trimStart().startsWith("==");

export const scanBlocks = (lines: readonly string[]): Block[] => {
  const heads: number[] = [];
  lines.forEach((line, i) => {
    if (isHeading(line)) {
      heads.push(i);
    }
  });
  const blocks: Block[] = [];
  let conversation = "";
  heads.forEach((start, n) => {
    const last = (n + 1 < heads.length ? heads[n + 1] : lines.length) - 1;
    const words = lines[start].trim().replace(/^==/, "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return;
    }
    const body = lines.slice(start + 1, last + 1);
    let kind: BlockKind;
    let name: string;
    if (words.length === 2 && DECLARED.has(words[0])) {
      kind = words[0] as BlockKind;
      name = words[1];
    } else {
      name = words[0];
      const first = body.find((l) => l.trim() !== "" && !NOTE.test(l));
      if (first !== undefined && /^\s*send:/.test(first)) {
        kind = "conversation";
        conversation = name;
      } else if (body.some((l) => TASK_LINE.test(l))) {
        kind = "task";
      } else {
        kind = "section";
      }
    }
    blocks.push({ kind, name, heading: start, last, conversation: kind === "section" ? conversation : "" });
  });
  return blocks;
};

/** Which block a zero-based line falls in, if any. */
export const blockAt = (blocks: readonly Block[], line: number): Block | undefined =>
  blocks.find((b) => line >= b.heading && line <= b.last);

/** The names declared in a file, by kind. */
export type Names = {
  tasks: string[];
  conversations: string[];
  people: string[];
  items: string[];
  places: string[];
};

export const emptyNames = (): Names => ({ tasks: [], conversations: [], people: [], items: [], places: [] });

export const namesOf = (blocks: readonly Block[]): Names => {
  const names = emptyNames();
  for (const b of blocks) {
    if (b.kind === "task") names.tasks.push(b.name);
    else if (b.kind === "conversation") names.conversations.push(b.name);
    else if (b.kind === "person") names.people.push(b.name);
    else if (b.kind === "item") names.items.push(b.name);
    else if (b.kind === "place") names.places.push(b.name);
  }
  return names;
};

export const mergeNames = (a: Names, b: Names): Names => ({
  tasks: [...new Set([...a.tasks, ...b.tasks])],
  conversations: [...new Set([...a.conversations, ...b.conversations])],
  people: [...new Set([...a.people, ...b.people])],
  items: [...new Set([...a.items, ...b.items])],
  places: [...new Set([...a.places, ...b.places])]
});
