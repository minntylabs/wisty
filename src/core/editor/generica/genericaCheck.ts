/**
 * Underlines the game's own checker's faults. The checker runs in Rust
 * (`run_story_check`) on the text on screen, a moment after typing stops.
 */

import { invoke } from "@tauri-apps/api/core";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { GenericaContext } from "./genericaContext";

type StoryFault = { file: string; line: number; text: string };

export type Faults = { faults: StoryFault[] } | { problem: string };

export const checkText = async (context: GenericaContext, filePath: string, text: string): Promise<Faults> => {
  if (context.gameDir === null) {
    return { problem: "No game folder (with project.godot) above the story folder, so the checker cannot run." };
  }
  try {
    const faults = await invoke<StoryFault[]>("run_story_check", {
      gameDir: context.gameDir,
      storyDir: context.storyDir,
      file: filePath,
      text
    });
    return { faults };
  } catch (error) {
    return { problem: `The checker did not run: ${typeof error === "string" ? error : String(error)}` };
  }
};

/** Diagnostics for the faults that belong to this file. */
export const diagnosticsFor = (view: EditorView, relative: string, result: Faults): Diagnostic[] => {
  const doc = view.state.doc;
  if ("problem" in result) {
    return [{ from: 0, to: doc.line(1).to, severity: "warning", message: result.problem }];
  }
  const out: Diagnostic[] = [];
  for (const fault of result.faults) {
    if (fault.file !== relative) {
      continue;
    }
    const line = doc.line(Math.min(Math.max(fault.line, 1), doc.lines));
    const lead = line.text.length - line.text.trimStart().length;
    out.push({
      from: line.from + lead,
      to: Math.max(line.to, line.from + lead),
      severity: "error",
      message: fault.text,
      source: "story check"
    });
  }
  return out;
};

export type CheckSources = {
  getFilePath: () => string;
  getContext: () => Promise<GenericaContext | null>;
};

export const genericaCheck = (sources: CheckSources): Extension => {
  let chain: Promise<unknown> = Promise.resolve();
  return linter(
    (view) => {
      const run = async (): Promise<Diagnostic[]> => {
        const filePath = sources.getFilePath();
        const context = await sources.getContext();
        if (!context || !filePath.startsWith(`${context.storyDir}/`)) {
          return [];
        }
        const relative = filePath.slice(context.storyDir.length + 1);
        const result = await checkText(context, filePath, view.state.doc.toString());
        return diagnosticsFor(view, relative, result);
      };
      // One check at a time: each runs the whole checker.
      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next;
    },
    { delay: 1200 }
  );
};
