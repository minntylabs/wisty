import { Compartment, EditorSelection, EditorState, Text, Transaction } from "@codemirror/state";
import { defaultKeymap, history, indentWithTab, isolateHistory, redo, undo } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { drawSelection, dropCursor, EditorView, highlightActiveLine, keymap } from "@codemirror/view";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { TextSnapshot } from "../app/contracts";
import { AppSettings, FormatViewMode, RememberedPosition } from "../settings/settingsTypes";
import {
  createFormatting,
  setFormatModeEffect,
  setHeadingLevel,
  toggleBold,
  toggleItalic
} from "./formatting/formatExtension";
import { createSearchPanelAdapter } from "./searchPanelAdapter";
import { createSpellService } from "../spellcheck/spellService";
import { createSpellcheckExtension, requestSpellRescan } from "../spellcheck/spellcheckExtension";
import { createWordCounter } from "./wordCount";
import { createTranscriptExtension, transcriptHoverSelection } from "./transcript/transcriptExtension";
import { createMarkers, setMarkersVisibleEffect } from "./markers/markerExtension";

type DocChangedPayload = {
  revision: number;
};

export type CursorPositionPayload = {
  currentLine: number;
  totalLines: number;
  currentCharacter: number;
  totalCharacters: number;
};

const positionsEqual = (a: CursorPositionPayload, b: CursorPositionPayload): boolean =>
  (Object.keys(a) as (keyof CursorPositionPayload)[]).every((key) => a[key] === b[key]);

const clampLine = (lineNumber: number, totalLines: number): number =>
  Math.max(1, Math.min(totalLines, Math.floor(lineNumber)));

type EditorAdapterOptions = {
  onDocChanged: (payload: DocChangedPayload) => void;
  onCursorPositionChanged: (payload: CursorPositionPayload) => void;
  /**
   * The document's word count, which arrives after typing stops rather than
   * with each edit — see `wordCount` for why it cannot be counted inline.
   */
  onWordCountChanged?: (words: number) => void;
  onFormatModeChanged: (mode: FormatViewMode) => void;
  /** Fired when the viewport or caret moves, so a remembered position can be re-captured. */
  onViewPositionChanged?: () => void;
  getSettings: () => AppSettings;
  /**
   * Called when a time marker's icon is clicked, with the marker's own times.
   *
   * Injected rather than imported so the editor layer never depends on audio:
   * App.tsx wires this to core/audio, and the editor stays constructible in a
   * test with no playback at all.
   */
  onMarkerClick?: (start: number, end: number) => void;
  /** Escape was pressed in a transcript. Silences whatever is playing. */
  onStopPlayback?: () => void;
};

type SetTextOptions = {
  emitChange?: boolean;
};

type AppendTextOptions = {
  emitChange?: boolean;
  addToHistory?: boolean;
};

type ResetEditorOptions = {
  emitChange?: boolean;
  addToHistory?: boolean;
};

export const createEditorAdapter = (options: EditorAdapterOptions) => {
  let editorHost: HTMLDivElement | undefined;
  let editorView: EditorView | undefined;
  let revision = 0;
  const wordCounter = createWordCounter({
    // Read afresh each time: whichever document is open when the scan runs is
    // the one it should be counting.
    readLines: () => editorView?.state.doc.iterLines() ?? [],
    onCount: (words) => options.onWordCountChanged?.(words)
  });
  let suppressDocEvents = 0;
  let largeLineSafeModeEnabled = false;
  let lastReportedPosition: CursorPositionPayload | undefined;
  const searchPanelAdapter = createSearchPanelAdapter();

  const spellService = createSpellService();
  const spellExtension = createSpellcheckExtension(spellService);
  let spellEnabled = false;
  let spellLoadedLanguage: string | undefined;
  let spellDictionaryDirty = false;
  let spellConfigurationGeneration = 0;

  const transcriptExtension = createTranscriptExtension();
  // Markers are installed per document rather than always, because tracking
  // them costs work proportional to how many there are, and an ordinary text
  // file has none to find. Measured at ~6ms per keystroke on a 10MB document,
  // which is the difference between typing feeling fine and feeling broken.
  const markers = createMarkers({
    getInitialVisible: () => options.getSettings().markersVisible,
    onMarkerClick: (start, end) => options.onMarkerClick?.(start, end),
    onStop: () => options.onStopPlayback?.()
  });
  let transcriptEnabled = false;
  let markersEnabled = false;

  const wrapCompartment = new Compartment();
  const activeLineCompartment = new Compartment();
  const styleCompartment = new Compartment();
  const spellCompartment = new Compartment();
  const transcriptCompartment = new Compartment();
  const markerCompartment = new Compartment();

  const formatting = createFormatting(() => options.getSettings().formatViewMode);

  const createStyleExtension = () => {
    const settings = options.getSettings();
    const isDark = settings.themeMode === "dark";

    return EditorView.theme({
      "&": {
        height: "100%",
        color: isDark ? "#d7dfef" : "#1c2736",
        "background-color": isDark ? "#111925" : "#ffffff",
        "font-family": settings.fontFamily,
        "font-size": `${settings.fontSize}px`
      },
      ".cm-content": {
        padding: "12px 14px",
        "min-height": "100%",
        "font-family": settings.fontFamily,
        "font-style": settings.fontStyle,
        "font-weight": `${settings.fontWeight}`,
        caretColor: isDark ? "#8cb2ff" : "#2451c5"
      },
      ".cm-gutters": {
        "background-color": isDark ? "#111925" : "#ffffff",
        color: isDark ? "#4f657f" : "#9aacbf",
        border: "none"
      },
      ".cm-scroller": {
        overflow: "auto",
        "font-family": settings.fontFamily,
        "font-style": settings.fontStyle,
        "font-weight": `${settings.fontWeight}`,
        "line-height": "1.55"
      },
      ".cm-activeLine": {
        background: isDark ? "rgba(124, 152, 202, 0.14)" : "rgba(194, 214, 246, 0.34)"
      },
      ".cm-selectionBackground": {
        background: isDark ? "rgba(59,130,246,0.38)" : "rgba(147,197,253,0.55)"
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
        background: isDark ? "rgba(59,130,246,0.38)" : "rgba(147,197,253,0.55)"
      },
      ".cm-content ::selection": {
        background: isDark ? "rgba(59,130,246,0.38)" : "rgba(147,197,253,0.55)"
      },
      ".cm-panels-top": {
        border: "none",
        "border-top": `${isDark ? "1px solid #374151" : "1px solid #e5e7eb"} !important`,
        "border-bottom": `${isDark ? "1px solid #374151" : "1px solid #e5e7eb"} !important`,
        padding: "6px 8px",
        "background-color": `${isDark ? "#1f2937" : "#ffffff"} !important`,
        color: isDark ? "#ffffff" : "#000000"
      },
      ".cm-panel.cm-search": {
        border: "none !important"
      },
      ".cm-panels": {
        "background-color": `${isDark ? "#1f2937" : "#ffffff"} !important`,
        color: isDark ? "#ffffff" : "#000000"
      },
      ".cm-search": {
        "font-family": "var(--font-menu)",
        "font-size": "13px",
        color: isDark ? "#ffffff" : "#000000",
        "background-color": isDark ? "#1f2937" : "#ffffff"
      },
      ".cm-panel.cm-search label": {
        "font-family": "var(--font-menu)",
        "font-size": "13px",
        color: isDark ? "#ffffff" : "#000000"
      },
      ".cm-search [name=close]": {
        color: isDark ? "#ffffff" : "#1f2937",
        opacity: "0.85"
      },
      ".cm-search [name=close]:hover": {
        opacity: "1"
      },
      ".cm-search input": {
        "font-family": "var(--font-menu)",
        "font-size": "13px",
        border: isDark ? "1px solid #374151" : "1px solid #e5e7eb",
        padding: "3px 6px",
        "border-radius": "4px",
        color: isDark ? "#d7dfef" : "#1c2736",
        "background-color": isDark ? "#152130" : "#ffffff"
      },
      ".cm-search input:focus": {
        outline: "none",
        "border-color": isDark ? "#4b6b99" : "#9eb7df",
        "box-shadow": isDark ? "0 0 0 1px #4b6b99" : "0 0 0 1px #9eb7df"
      },
      ".cm-search input[type=checkbox]": {
        "accent-color": isDark ? "#8cb2ff" : "#2451c5"
      },
      ".cm-panels .cm-button": {
        "font-family": "var(--font-menu)",
        "font-size": "13px",
        border: isDark ? "1px solid #374151" : "1px solid #e5e7eb",
        "border-radius": "4px",
        padding: "3px 7px",
        color: isDark ? "#ffffff" : "#000000",
        "background-color": isDark ? "#374151" : "#f3f4f6",
        "background-image": "none",
        appearance: "none"
      },
      ".cm-panels .cm-button:hover": {
        "background-color": isDark ? "#4b5563" : "#e5e7eb"
      },
      ".cm-panels .cm-button:active": {
        "background-color": isDark ? "#334155" : "#dbe3ee"
      }
    }, { dark: isDark });
  };

  const historyBoundaryExtension = EditorState.transactionExtender.of((tr) => {
    if (!tr.docChanged) {
      return null;
    }
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) {
      return null;
    }

    if (tr.isUserEvent("delete.cut") || tr.isUserEvent("input.paste")) {
      return { annotations: isolateHistory.of("full") };
    }

    if (!tr.isUserEvent("input.type")) {
      return null;
    }

    let crossedWordBoundary = false;
    tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
      if (crossedWordBoundary) {
        return;
      }
      if (/[\s.,;:!?()[\]{}]/.test(inserted.toString())) {
        crossedWordBoundary = true;
      }
    });

    if (!crossedWordBoundary) {
      return null;
    }

    return { annotations: isolateHistory.of("after") };
  });

  const createEditorState = (doc: string) => {
    const settings = options.getSettings();

    return EditorState.create({
      doc,
      extensions: [
        search(),
        history({
          newGroupDelay: 150,
          joinToEvent: (tr, isAdjacent) => {
            if (!isAdjacent) {
              return false;
            }
            return tr.isUserEvent("input.type") || tr.isUserEvent("delete.backward") || tr.isUserEvent("delete.forward");
          }
        }),
        historyBoundaryExtension,
        drawSelection(),
        dropCursor(),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...searchKeymap.filter((binding) => binding.key !== "Mod-f")
        ]),
        wrapCompartment.of(!largeLineSafeModeEnabled && settings.textWrapEnabled ? EditorView.lineWrapping : []),
        activeLineCompartment.of(settings.activeLineHighlightEnabled ? highlightActiveLine() : []),
        spellCompartment.of(spellEnabled ? spellExtension : []),
        transcriptCompartment.of(transcriptEnabled ? transcriptExtension : []),
        markerCompartment.of(markersEnabled ? markers.extension : []),
        styleCompartment.of(createStyleExtension()),
        formatting.extension,
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet) {
            emitCursorPositionIfChanged(update.state);
            const onlyTranscriptHover =
              update.selectionSet
              && !update.docChanged
              && update.transactions.every((tr) => tr.annotation(transcriptHoverSelection));
            if (!onlyTranscriptHover) {
              options.onViewPositionChanged?.();
            }
          }

          const previousMode = update.startState.field(formatting.modeField);
          const nextMode = update.state.field(formatting.modeField);
          if (previousMode !== nextMode) {
            options.onFormatModeChanged(nextMode);
          }

          if (!update.docChanged) {
            return;
          }
          wordCounter.schedule();
          revision += 1;
          if (suppressDocEvents > 0) {
            return;
          }
          options.onDocChanged({ revision });
        })
      ]
    });
  };

  const emitCursorPositionIfChanged = (state: EditorState) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    // Characters are counted behind the caret: how many of the line's
    // characters it has passed, out of how many the line has. So a line of one
    // character reads "0 of 1" with the caret before it and "1 of 1" after it,
    // and the total is the number of characters that are actually there —
    // counting caret positions instead would claim a line of one character has
    // two. `line.length` excludes the line break, which is not a character the
    // caret can be placed either side of on this line.
    const position: CursorPositionPayload = {
      currentLine: line.number,
      totalLines: state.doc.lines,
      currentCharacter: head - line.from,
      totalCharacters: line.length
    };

    if (lastReportedPosition && positionsEqual(lastReportedPosition, position)) {
      return;
    }

    lastReportedPosition = position;
    options.onCursorPositionChanged(position);
  };

  const dispatchTextChange = (
    changes: { from: number; to: number; insert: string },
    editOptions: { emitChange?: boolean; addToHistory?: boolean }
  ) => {
    if (!editorView) {
      return;
    }

    const emitChange = editOptions.emitChange ?? true;
    const addToHistory = editOptions.addToHistory ?? true;

    if (!emitChange) {
      suppressDocEvents += 1;
    }
    try {
      editorView.dispatch({
        changes,
        annotations: [Transaction.addToHistory.of(addToHistory)]
      });
    } finally {
      if (!emitChange) {
        suppressDocEvents = Math.max(0, suppressDocEvents - 1);
      }
    }
  };

  const handleScroll = () => {
    options.onViewPositionChanged?.();
  };

  /**
   * The first visible line and the caret, as line/column. Read from the
   * scroller's top-left corner rather than from scrollTop, so the answer is in
   * document terms and survives a later change of font, wrapping or window size.
   */
  const getViewPosition = (): RememberedPosition | null => {
    const view = editorView;
    if (!view) {
      return null;
    }

    const bounds = view.scrollDOM.getBoundingClientRect();
    const topPos = view.posAtCoords({ x: bounds.left + 1, y: bounds.top + 1 }, false);
    const head = view.state.selection.main.head;
    const cursorLine = view.state.doc.lineAt(head);

    return {
      topLine: view.state.doc.lineAt(topPos).number,
      cursorLine: cursorLine.number,
      cursorColumn: head - cursorLine.from
    };
  };

  /**
   * Restores a remembered position, clamping to the document as it is now — the
   * file may have been edited elsewhere since, and a stale line number should
   * land somewhere sensible rather than fail.
   */
  const setViewPosition = (position: RememberedPosition) => {
    const view = editorView;
    if (!view) {
      return;
    }

    const { doc } = view.state;
    const cursorLine = doc.line(clampLine(position.cursorLine, doc.lines));
    const topLine = doc.line(clampLine(position.topLine, doc.lines));

    view.dispatch({
      selection: EditorSelection.cursor(
        Math.min(cursorLine.from + position.cursorColumn, cursorLine.to)
      ),
      effects: EditorView.scrollIntoView(topLine.from, { y: "start" })
    });
  };

  const setHost = (node: HTMLDivElement) => {
    editorHost = node;
  };

  const init = () => {
    if (!editorHost || editorView) {
      return;
    }

    editorView = new EditorView({
      parent: editorHost,
      state: createEditorState("")
    });

    // Scrolling produces no transaction, so the update listener never sees it.
    editorView.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });

    emitCursorPositionIfChanged(editorView.state);
    // An empty document still has a count to report.
    wordCounter.schedule();
  };

  const destroy = () => {
    if (!editorView) {
      return;
    }
    editorView.scrollDOM.removeEventListener("scroll", handleScroll);
    wordCounter.cancel();
    editorView.destroy();
    editorView = undefined;
  };

  const focus = () => {
    editorView?.focus();
  };

  const getText = () => editorView?.state.doc.toString() ?? "";

  const sliceDoc = (doc: Text, from: number, to: number) => {
    const safeFrom = Math.max(0, Math.min(doc.length, Math.floor(from)));
    const safeTo = Math.max(safeFrom, Math.min(doc.length, Math.floor(to)));
    if (safeFrom === safeTo) {
      return "";
    }
    return doc.sliceString(safeFrom, safeTo);
  };

  /**
   * CodeMirror documents are persistent, so holding one costs a reference
   * rather than a copy of the text. That is what makes this affordable on the
   * files the streaming save exists for: the alternative, `getText()`, doubles
   * a large document in memory to produce a single string.
   */
  const snapshotText = (): TextSnapshot => {
    const doc = editorView?.state.doc;
    if (!doc) {
      return { length: 0, revision, slice: () => "" };
    }
    return {
      length: doc.length,
      revision,
      slice: (from: number, to: number) => sliceDoc(doc, from, to)
    };
  };

  const getRevision = () => revision;

  const setText = (text: string, setTextOptions: SetTextOptions = {}) => {
    if (!editorView) {
      return;
    }
    dispatchTextChange({
      from: 0,
      to: editorView.state.doc.length,
      insert: text
    }, {
      emitChange: setTextOptions.emitChange,
      addToHistory: true
    });
  };

  const append = (text: string, appendOptions: AppendTextOptions = {}) => {
    if (!editorView) {
      return;
    }

    if (typeof text !== "string") {
      throw new Error(`Editor append expects string text, received ${typeof text}`);
    }

    if (text.length === 0) {
      return;
    }

    const from = editorView.state.doc.length;
    dispatchTextChange({
      from,
      to: from,
      insert: text
    }, {
      emitChange: appendOptions.emitChange,
      addToHistory: appendOptions.addToHistory ?? false
    });
  };

  const reset = (resetOptions: ResetEditorOptions = {}) => {
    if (!editorView) {
      return;
    }

    const emitChange = resetOptions.emitChange ?? true;
    void resetOptions.addToHistory;

    const nextState = createEditorState("");
    editorView.setState(nextState);
    revision = 0;
    editorView.scrollDOM.scrollTop = 0;
    editorView.scrollDOM.scrollLeft = 0;
    emitCursorPositionIfChanged(editorView.state);

    if (emitChange) {
      options.onDocChanged({ revision });
    }
  };

  const applySettings = () => {
    if (!editorView) {
      return;
    }
    const settings = options.getSettings();
    editorView.dispatch({
      effects: [
        wrapCompartment.reconfigure(!largeLineSafeModeEnabled && settings.textWrapEnabled ? EditorView.lineWrapping : []),
        activeLineCompartment.reconfigure(settings.activeLineHighlightEnabled ? highlightActiveLine() : []),
        styleCompartment.reconfigure(createStyleExtension())
      ]
    });
  };

  const listSpellDictionaries = () => spellService.listDictionaries();

  const listAddedWords = () => spellService.listAddedWords();

  const removeAddedWord = async (word: string) => {
    await spellService.removeWord(word);
    if (!spellLoadedLanguage) {
      return;
    }
    if (spellEnabled) {
      await spellService.loadDictionary(spellLoadedLanguage);
      if (editorView) {
        editorView.dispatch({ effects: requestSpellRescan.of(null) });
      }
    } else {
      // Defer the reload until spellcheck is next enabled, since disabled
      // spellcheck has no live dictionary to benefit from it right now.
      spellDictionaryDirty = true;
    }
  };

  const configureSpellcheck = async ({ enabled, language }: { enabled: boolean; language: string }) => {
    const generation = ++spellConfigurationGeneration;
    if (enabled && language && (language !== spellLoadedLanguage || spellDictionaryDirty)) {
      const loaded = await spellService.loadDictionary(language);
      if (generation !== spellConfigurationGeneration) {
        return;
      }
      spellLoadedLanguage = loaded ? language : undefined;
      spellDictionaryDirty = false;
    }

    if (generation !== spellConfigurationGeneration) {
      return;
    }

    spellEnabled = enabled && spellLoadedLanguage !== undefined;

    if (!editorView) {
      return;
    }
    editorView.dispatch({
      effects: spellCompartment.reconfigure(spellEnabled ? spellExtension : [])
    });
    if (spellEnabled) {
      editorView.dispatch({ effects: requestSpellRescan.of(null) });
    }
  };

  /**
   * Installs or removes the transcript-mode extension outright, so its
   * destructive pointer handlers do not exist while the mode is off.
   */
  const setTranscriptMode = (enabled: boolean) => {
    if (transcriptEnabled === enabled) {
      return;
    }
    transcriptEnabled = enabled;
    editorView?.dispatch({
      effects: transcriptCompartment.reconfigure(enabled ? transcriptExtension : [])
    });
  };

  const isTranscriptModeEnabled = () => transcriptEnabled;

  /**
   * Installs or removes marker handling, following the document rather than a
   * user preference: only a transcript container has markers, and a document
   * with none should not pay to look for them.
   */
  const setMarkersEnabled = (enabled: boolean) => {
    if (markersEnabled === enabled) {
      return;
    }
    markersEnabled = enabled;
    editorView?.dispatch({
      effects: markerCompartment.reconfigure(enabled ? markers.extension : [])
    });
  };

  /**
   * Shows or hides the marker icons. Separate from installing the extension:
   * hiding is a view preference and costs one class on the content element,
   * where uninstalling would stop the caret and edit protection working.
   */
  const setMarkersVisible = (visible: boolean) => {
    if (!markersEnabled) {
      return;
    }
    editorView?.dispatch({ effects: setMarkersVisibleEffect.of(visible) });
  };

  const setLargeLineSafeMode = (enabled: boolean) => {
    if (largeLineSafeModeEnabled === enabled) {
      return;
    }
    largeLineSafeModeEnabled = enabled;
    applySettings();
  };

  const openOrFocusFindPanel = () => {
    if (!editorView) {
      return false;
    }
    return searchPanelAdapter.openOrFocusFindPanel(editorView);
  };

  const openOrFocusReplacePanel = () => {
    if (!editorView) {
      return false;
    }
    return searchPanelAdapter.openOrFocusReplacePanel(editorView);
  };

  const getSelectedText = () => {
    const view = editorView;
    if (!view) {
      return "";
    }
    const ranges = view.state.selection.ranges.filter((range) => !range.empty);
    if (ranges.length === 0) {
      return "";
    }
    return ranges.map((range) => view.state.sliceDoc(range.from, range.to)).join("\n");
  };

  const copySelection = async () => {
    const text = getSelectedText();
    if (!text) {
      return false;
    }
    await writeText(text);
    return true;
  };

  const cutSelection = async () => {
    const view = editorView;
    if (!view) {
      return false;
    }
    const state = view.state;
    const ranges = state.selection.ranges.filter((range) => !range.empty);
    if (ranges.length === 0) {
      return false;
    }
    const text = ranges.map((range) => state.sliceDoc(range.from, range.to)).join("\n");
    await writeText(text);
    // Clipboard access yields to the event loop. Do not turn a cursor move or
    // edit during that wait into deletion of a different selection.
    if (view.state !== state) {
      return true;
    }
    view.dispatch({
      ...state.replaceSelection(""),
      userEvent: "delete.cut",
      annotations: [
        Transaction.addToHistory.of(true),
        isolateHistory.of("full")
      ]
    });
    return true;
  };

  const pasteSelection = async () => {
    const view = editorView;
    if (!view) {
      return false;
    }
    const text = await readText();
    if (!text) {
      return false;
    }
    view.dispatch({
      ...view.state.replaceSelection(text),
      userEvent: "input.paste",
      annotations: [
        Transaction.addToHistory.of(true),
        isolateHistory.of("full")
      ]
    });
    return true;
  };

  const setFormatMode = (mode: FormatViewMode) => {
    editorView?.dispatch({ effects: setFormatModeEffect.of(mode) });
  };

  const getFormatMode = (): FormatViewMode =>
    editorView ? editorView.state.field(formatting.modeField) : options.getSettings().formatViewMode;

  const toggleBoldFormat = () => {
    if (editorView) {
      toggleBold(editorView);
    }
  };

  const toggleItalicFormat = () => {
    if (editorView) {
      toggleItalic(editorView);
    }
  };

  const applyHeadingLevel = (level: number) => {
    if (editorView) {
      setHeadingLevel(editorView, level);
    }
  };

  const undoEdit = () => {
    if (!editorView) {
      return false;
    }
    editorView.focus();
    return undo(editorView);
  };

  const redoEdit = () => {
    if (!editorView) {
      return false;
    }
    editorView.focus();
    return redo(editorView);
  };

  return {
    setHost,
    init,
    destroy,
    focus,
    getText,
    snapshotText,
    setText,
    append,
    reset,
    setLargeLineSafeMode,
    getViewPosition,
    setViewPosition,
    setTranscriptMode,
    isTranscriptModeEnabled,
    setMarkersEnabled,
    setMarkersVisible,
    listSpellDictionaries,
    listAddedWords,
    removeAddedWord,
    configureSpellcheck,
    setFormatMode,
    getFormatMode,
    toggleBold: toggleBoldFormat,
    toggleItalic: toggleItalicFormat,
    applyHeadingLevel,
    applySettings,
    openOrFocusFindPanel,
    openOrFocusReplacePanel,
    cutSelection,
    copySelection,
    pasteSelection,
    undoEdit,
    redoEdit,
    getRevision
  };
};
