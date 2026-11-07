/**
 * Generica mode, for `.tale` files: colours, auto-complete, go to section and
 * the game's checker. Turned on by the editor when the open file ends `.tale`.
 */

import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { genericaCheck } from "./genericaCheck";
import { genericaCompletion } from "./genericaComplete";
import { findContext, otherFileNames, type GenericaContext } from "./genericaContext";
import { genericaJump } from "./genericaJump";
import type { Phrases } from "./genericaPhrases";
import { emptyNames, type Names } from "./genericaScan";
import { genericaHighlight } from "./genericaSyntax";

export const isGenericaPath = (path: string): boolean => path.toLowerCase().endsWith(".tale");

export const createGenericaExtension = (getFilePath: () => string): Extension => {
  let contextFor = "";
  let contextPromise: Promise<GenericaContext | null> | null = null;
  let phrases: Phrases = {};
  let otherNames: Names = emptyNames();
  let namesAt = 0;

  // Looked up afresh whenever the file's path changes, and again a minute
  // after the last time, so a rewritten `phrases.txt` is picked up.
  let contextAt = 0;
  const getContext = (): Promise<GenericaContext | null> => {
    const path = getFilePath();
    if (contextPromise === null || contextFor !== path || Date.now() - contextAt > 60_000) {
      contextFor = path;
      contextAt = Date.now();
      contextPromise = findContext(path)
        .then((found) => {
          if (found) {
            phrases = found.phrases;
          }
          return found;
        })
        .catch(() => null);
    }
    return contextPromise;
  };

  const getOtherNames = (): Names => {
    // Fresh enough while typing, refreshed in the background every few seconds.
    if (Date.now() - namesAt > 5_000) {
      namesAt = Date.now();
      void getContext().then(async (context) => {
        if (context) {
          otherNames = await otherFileNames(context.storyDir, getFilePath()).catch(() => emptyNames());
        }
      });
    }
    return otherNames;
  };

  return [
    genericaHighlight(),
    genericaCompletion({ getPhrases: () => {
        void getContext();
        return phrases;
      }, getOtherNames }),
    genericaJump(),
    genericaCheck({ getFilePath, getContext })
  ];
};

/**
 * Switching the mode on and off with the open file. The path is remembered
 * here, so a document state rebuilt later (a new file being opened) starts
 * with the right answer.
 */
export const createGenericaMode = () => {
  const compartment = new Compartment();
  let path = "";
  const extension = createGenericaExtension(() => path);
  const on = () => isGenericaPath(path);
  return {
    /** For the editor state's own extension list. */
    initial: (): Extension => compartment.of(on() ? extension : []),
    setFilePath: (view: EditorView | null, next: string) => {
      const was = on();
      path = next;
      if (view && was !== on()) {
        view.dispatch({ effects: compartment.reconfigure(on() ? extension : []) });
      }
    }
  };
};
