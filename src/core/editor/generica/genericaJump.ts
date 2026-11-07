/**
 * Go to the section (or task) a line names. `jumpTarget` is pure: given the
 * lines and a position it says which zero-based heading line to go to.
 */

import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { blockAt, scanBlocks } from "./genericaScan";

/** The name a line jumps to, with its column range: `-> name` or `task: name`. */
const nameOnLine = (text: string): { name: string; from: number; to: number; task: boolean } | null => {
  const jump = /->[ \t]*([a-z0-9_]+)\s*$/.exec(text);
  if (jump) {
    const to = jump.index + jump[0].trimEnd().length;
    const name = jump[1];
    return { name, from: to - name.length, to, task: false };
  }
  const task = /^(\s*task:\s*)([a-z0-9_]+)\s*$/.exec(text);
  if (task) {
    return { name: task[2], from: task[1].length, to: task[1].length + task[2].length, task: true };
  }
  return null;
};

export const jumpTarget = (lines: readonly string[], line: number, col?: number): number | null => {
  const found = nameOnLine(lines[line] ?? "");
  if (!found || (col !== undefined && (col < found.from || col > found.to))) {
    return null;
  }
  const blocks = scanBlocks(lines);
  if (found.task) {
    return blocks.find((b) => b.kind === "task" && b.name === found.name)?.heading ?? null;
  }
  const conversation = blockAt(blocks, line)?.conversation ?? "";
  return (
    blocks.find((b) => b.kind === "section" && b.conversation === conversation && b.name === found.name)?.heading ?? null
  );
};

const goTo = (view: EditorView, line: number, col?: number): boolean => {
  const lines: string[] = [];
  for (let n = 1; n <= view.state.doc.lines; n++) {
    lines.push(view.state.doc.line(n).text);
  }
  const target = jumpTarget(lines, line, col);
  if (target === null) {
    return false;
  }
  const at = view.state.doc.line(target + 1).from;
  view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 40 }) });
  view.focus();
  return true;
};

/** F12 jumps from the caret's line; Ctrl-click (Cmd-click) on the name does too. */
export const genericaJump = (): Extension => [
  keymap.of([
    {
      key: "F12",
      run: (view) => goTo(view, view.state.doc.lineAt(view.state.selection.main.head).number - 1)
    }
  ]),
  EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return false;
      }
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) {
        return false;
      }
      const line = view.state.doc.lineAt(pos);
      if (goTo(view, line.number - 1, pos - line.from)) {
        event.preventDefault();
        return true;
      }
      return false;
    }
  })
];
