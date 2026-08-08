import { createStore } from "solid-js/store";

/**
 * What the open document actually is on disk.
 *
 * A container (.tsf) holds the transcript alongside its recording, so it cannot
 * be written by streaming the editor's text at its path — that would replace
 * the archive with plain text and lose the audio. Saving, Save As and the
 * marker extension all need to know which they are dealing with, and deriving
 * it from the extension at each of those places is how they come to disagree.
 */
export type DocumentKind = "text" | "container";

export type DocumentMetaState = {
  filePath: string;
  fileName: string;
  kind: DocumentKind;
  isDirty: boolean;
  currentRevision: number;
  baselineRevision: number;
};

const UNTITLED = "Untitled";

const fileNameFromPath = (filePath: string) => {
  if (!filePath) {
    return UNTITLED;
  }
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || UNTITLED;
};

export const createDocumentStore = () => {
  const [state, setState] = createStore<DocumentMetaState>({
    filePath: "",
    fileName: UNTITLED,
    kind: "text",
    isDirty: false,
    currentRevision: 0,
    baselineRevision: 0
  });

  const setRevision = (revision: number) => {
    setState({
      currentRevision: revision,
      isDirty: revision !== state.baselineRevision
    });
  };

  const markCleanAt = (revision: number) => {
    setState({
      currentRevision: revision,
      baselineRevision: revision,
      isDirty: false
    });
  };

  /** Records a saved editor revision without hiding edits made during the save. */
  const markSavedAt = (revision: number) => {
    setState({
      baselineRevision: revision,
      isDirty: state.currentRevision !== revision
    });
  };

  /**
   * `kind` defaults to "text", so every existing caller keeps marking the
   * document a plain text file — which is what saving to a path through the
   * text stream means. Only opening a container passes anything else, and it
   * has to say so explicitly.
   */
  const setFilePath = (filePath: string, kind: DocumentKind = "text") => {
    setState({
      filePath,
      fileName: fileNameFromPath(filePath),
      kind
    });
  };

  const setUntitled = () => {
    setState({ filePath: "", fileName: UNTITLED, kind: "text" });
  };

  return {
    state,
    setRevision,
    markCleanAt,
    markSavedAt,
    setFilePath,
    setUntitled
  };
};
