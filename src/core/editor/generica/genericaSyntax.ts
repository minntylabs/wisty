/**
 * Colours for Generica. `classifyLines` is pure: for each line it says which
 * classes the whole line gets and which ranges (offsets within the line) get
 * their own. `genericaHighlight` turns that into editor decorations.
 */

import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { blockAt, scanBlocks, type Block } from "./genericaScan";

export type LineMark = { from: number; to: number; cls: string };
export type LineStyle = { line?: string; marks: LineMark[] };

const KEY = /^(\s*)(send|task|marker|done when|fails when|is|called|kind|placed|at|within):/;
const SPEAKER = /^(\s*)([A-Z][A-Za-z ]*):/;
const PLACEHOLDER = /\{[^{}]*\}/g;
const NAME = /[a-z0-9_]+/;

export const classifyLines = (lines: readonly string[]): LineStyle[] => {
  const blocks = scanBlocks(lines);
  return lines.map((text, i) => styleOf(text, i, blocks, lines));
};

const styleOf = (text: string, i: number, blocks: readonly Block[], lines: readonly string[]): LineStyle => {
  const style: LineStyle = { marks: [] };
  const trimmed = text.trim();
  if (trimmed === "") {
    return style;
  }
  if (trimmed.startsWith("#")) {
    style.line = "cm-gen-note";
    return style;
  }
  const block = blockAt(blocks, i);
  const placeholders = () => {
    for (const m of text.matchAll(PLACEHOLDER)) {
      style.marks.push({ from: m.index, to: m.index + m[0].length, cls: "cm-gen-placeholder" });
    }
  };

  if (trimmed.startsWith("==")) {
    style.line = "cm-gen-heading";
    if (block?.kind === "task") {
      const at = text.lastIndexOf(block.name);
      style.marks.push({ from: at, to: at + block.name.length, cls: "cm-gen-taskname" });
    }
    return style;
  }
  if (trimmed.startsWith("->")) {
    style.line = "cm-gen-jump";
    return style;
  }
  if (trimmed.startsWith(">")) {
    style.line = "cm-gen-reply";
    const arrow = text.lastIndexOf("->");
    if (arrow >= 0) {
      style.marks.push({ from: arrow, to: text.length, cls: "cm-gen-jump" });
    }
    placeholders();
    return style;
  }

  const key = KEY.exec(text);
  const inSection = block?.kind === "section";
  if (key && (!inSection || key[2] === "task" || key[2] === "send")) {
    const word = key[2];
    const keyEnd = key[0].length;
    if (word === "send") {
      style.line = "cm-gen-send";
      const after = /after\s+([a-z0-9_]+)/.exec(text);
      if (after) {
        const from = after.index + after[0].length - after[1].length;
        style.marks.push({ from, to: from + after[1].length, cls: "cm-gen-taskname" });
      }
    } else if (word === "task") {
      style.line = "cm-gen-taskline";
      const name = NAME.exec(text.slice(keyEnd));
      if (name) {
        style.marks.push({ from: keyEnd + name.index, to: keyEnd + name.index + name[0].length, cls: "cm-gen-taskname" });
      }
    } else {
      style.marks.push({ from: key[1].length, to: keyEnd, cls: "cm-gen-key" });
    }
    placeholders();
    return style;
  }

  const speaker = SPEAKER.exec(text);
  if (inSection && speaker) {
    style.line = "cm-gen-control";
    style.marks.push({ from: speaker[1].length, to: speaker[0].length, cls: "cm-gen-speaker" });
  } else if (inSection) {
    style.line = "cm-gen-control";
  } else if (block?.kind === "task" && firstTextLine(lines, block) === i) {
    style.line = "cm-gen-tasktext";
  }
  placeholders();
  return style;
};

/** The task's own sentence: its first line that is not blank, a note or a keyed line. */
const firstTextLine = (lines: readonly string[], block: Block): number => {
  for (let i = block.heading + 1; i <= block.last; i++) {
    const t = lines[i].trim();
    if (t !== "" && !t.startsWith("#")) {
      return KEY.test(lines[i]) ? -1 : i;
    }
  }
  return -1;
};

const MAX_CHARS = 400_000;

const buildDecorations = (view: EditorView): DecorationSet => {
  const doc = view.state.doc;
  if (doc.length > MAX_CHARS) {
    return Decoration.none;
  }
  const lines: string[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    lines.push(doc.line(n).text);
  }
  const styles = classifyLines(lines);
  const ranges: { from: number; to: number; value: Decoration }[] = [];
  styles.forEach((style, i) => {
    const line = doc.line(i + 1);
    if (style.line) {
      ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: style.line }) });
    }
    for (const m of style.marks) {
      if (m.to > m.from) {
        ranges.push({ from: line.from + m.from, to: line.from + m.to, value: Decoration.mark({ class: m.cls }) });
      }
    }
  });
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) {
    builder.add(r.from, r.to, r.value);
  }
  return builder.finish();
};

const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

const colours = (light: Record<string, string>, dark: Record<string, string>) => {
  const rules: Record<string, Record<string, string>> = {};
  for (const cls of Object.keys(light)) {
    rules[`&light ${cls}`] = { color: light[cls] };
    rules[`&dark ${cls}`] = { color: dark[cls] };
  }
  return rules;
};

const theme = EditorView.baseTheme({
  ...colours(
    {
      ".cm-gen-note": "#7a8a99",
      ".cm-gen-heading": "#8a3ea8",
      ".cm-gen-jump": "#c2570c",
      ".cm-gen-control": "#1b6b8f",
      ".cm-gen-speaker": "#0b4f70",
      ".cm-gen-reply": "#1f7a3d",
      ".cm-gen-send": "#9a6a00",
      ".cm-gen-taskline": "#9a6a00",
      ".cm-gen-tasktext": "#1c2736",
      ".cm-gen-key": "#6b7785",
      ".cm-gen-placeholder": "#c0267a",
      ".cm-gen-taskname": "#b3261e"
    },
    {
      ".cm-gen-note": "#6f8296",
      ".cm-gen-heading": "#c792ea",
      ".cm-gen-jump": "#f0a05a",
      ".cm-gen-control": "#7fc8e8",
      ".cm-gen-speaker": "#a8dcf2",
      ".cm-gen-reply": "#8fd6a0",
      ".cm-gen-send": "#e6c36a",
      ".cm-gen-taskline": "#e6c36a",
      ".cm-gen-tasktext": "#d7dfef",
      ".cm-gen-key": "#8c9bb0",
      ".cm-gen-placeholder": "#f07ab8",
      ".cm-gen-taskname": "#ff8a80"
    }
  ),
  ".cm-gen-heading": { fontWeight: "bold" },
  ".cm-gen-speaker": { fontWeight: "bold" },
  ".cm-gen-placeholder": { fontStyle: "italic" },
  ".cm-gen-taskname": { fontWeight: "bold" }
});

export const genericaHighlight = (): Extension => [highlightPlugin, theme];
