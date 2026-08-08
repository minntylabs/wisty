import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createFormatting,
  setFormatModeEffect,
  setHeadingLevel,
  toggleBold,
  toggleItalic
} from "./formatExtension";
import type { FormatViewMode } from "../../settings/settingsTypes";

const createView = (doc: string, mode: FormatViewMode = "formatted") => {
  const formatting = createFormatting(() => mode);
  const state = EditorState.create({ doc, extensions: [formatting.extension] });
  const view = new EditorView({ state, parent: document.body });
  return { view, formatting };
};

describe("formatting decorations", () => {
  it("hides heading markers and styles the line in formatted view", () => {
    const { view } = createView("## Heading");
    expect(view.dom.querySelector(".cm-fmt-h2")).not.toBeNull();
    expect(view.dom.textContent).toBe("Heading");
    view.destroy();
  });

  it("hides bold/italic markers and applies mark classes in formatted view", () => {
    const { view } = createView("**bold** and *italic* and _also italic_");
    expect(view.dom.querySelector(".cm-fmt-bold")?.textContent).toBe("bold");
    expect(view.dom.querySelectorAll(".cm-fmt-italic")).toHaveLength(2);
    expect(view.dom.textContent).toBe("bold and italic and also italic");
    view.destroy();
  });

  it("applies only the outer bold style to triple-star markup", () => {
    const { view } = createView("***bold italic***");
    expect(view.dom.querySelector(".cm-fmt-bold")?.textContent).toBe("*bold italic*");
    expect(view.dom.querySelector(".cm-fmt-italic")).toBeNull();
    expect(view.dom.textContent).toBe("*bold italic*");
    view.destroy();
  });

  it("applies only the outer bold style to nested syntax", () => {
    const { view } = createView("**one *two* three**");
    expect(view.dom.querySelector(".cm-fmt-bold")?.textContent).toBe("one *two* three");
    expect(view.dom.querySelector(".cm-fmt-italic")).toBeNull();
    expect(view.dom.textContent).toBe("one *two* three");
    view.destroy();
  });

  it("applies only the outer italic style to nested syntax", () => {
    const { view } = createView("*one **two** three*");
    expect(view.dom.querySelector(".cm-fmt-bold")).toBeNull();
    expect(view.dom.querySelector(".cm-fmt-italic")?.textContent).toBe("one **two** three");
    expect(view.dom.textContent).toBe("one **two** three");
    view.destroy();
  });

  it("leaves snake_case alone (underscore italic requires word boundaries)", () => {
    const { view } = createView("snake_case_name stays_put");
    expect(view.dom.querySelector(".cm-fmt-italic")).toBeNull();
    expect(view.dom.textContent).toBe("snake_case_name stays_put");
    view.destroy();
  });

  it("styles bold text that spans a line break", () => {
    const { view } = createView("**bold\nstill bold** after");
    const boldText = Array.from(view.dom.querySelectorAll(".cm-fmt-bold"))
      .map((el) => el.textContent)
      .join("");
    expect(boldText).toBe("boldstill bold");
    expect(view.dom.textContent).toBe("boldstill bold after");
    view.destroy();
  });

  it("styles bold across blank lines", () => {
    const { view } = createView("**one\n\ntwo**");
    const boldText = Array.from(view.dom.querySelectorAll(".cm-fmt-bold"))
      .map((el) => el.textContent)
      .join("");
    expect(boldText).toBe("onetwo");
    view.destroy();
  });

  it("keeps italic within a single line", () => {
    const { view } = createView("*one\ntwo* and _three\nfour_");
    expect(view.dom.querySelector(".cm-fmt-italic")).toBeNull();
    view.destroy();
  });

  it("gives up on spans longer than the length cap", () => {
    const { view } = createView(`**${"a".repeat(1001)}**`);
    expect(view.dom.querySelector(".cm-fmt-bold")).toBeNull();
    expect(view.dom.querySelector(".cm-fmt-italic")).toBeNull();
    view.destroy();
  });

  it("does not read star bullet lines as emphasis (whitespace-flanking rule)", () => {
    const { view } = createView("* first item\n* second item");
    expect(view.dom.querySelector(".cm-fmt-italic")).toBeNull();
    expect(view.dom.querySelector(".cm-fmt-bold")).toBeNull();
    view.destroy();
  });

  it("does not match empty emphasis runs like ****", () => {
    const { view } = createView("****");
    expect(view.dom.querySelector(".cm-fmt-bold")).toBeNull();
    expect(view.dom.textContent).toBe("****");
    view.destroy();
  });

  it("renders raw markup with no decorations in plain view", () => {
    const { view } = createView("## Heading\n**bold**", "plain");
    expect(view.dom.querySelector(".cm-fmt-h2")).toBeNull();
    expect(view.dom.querySelector(".cm-fmt-bold")).toBeNull();
    expect(view.dom.textContent).toBe("## Heading**bold**");
    view.destroy();
  });
});

describe("reveal-on-delete mode field", () => {
  it("starts in the mode returned by getInitialMode", () => {
    const { view, formatting } = createView("text", "formatted");
    expect(view.state.field(formatting.modeField)).toBe("formatted");
    view.destroy();
  });

  it("drops to plain when a transaction removes content", () => {
    const { view, formatting } = createView("hello", "formatted");
    view.dispatch({ changes: { from: 0, to: 1 } });
    expect(view.state.field(formatting.modeField)).toBe("plain");
    view.destroy();
  });

  it("stays formatted for pure insertions", () => {
    const { view, formatting } = createView("hello", "formatted");
    view.dispatch({ changes: { from: 5, insert: " world" } });
    expect(view.state.field(formatting.modeField)).toBe("formatted");
    view.destroy();
  });

  it("stays formatted when a deletion is annotated as a deliberate formatting edit", () => {
    const { view, formatting } = createView("**bold**", "formatted");
    toggleBold(view);
    expect(view.state.field(formatting.modeField)).toBe("formatted");
    view.destroy();
  });

  it("is overridden directly by setFormatModeEffect regardless of doc changes", () => {
    const { view, formatting } = createView("hello", "plain");
    view.dispatch({ effects: setFormatModeEffect.of("formatted") });
    expect(view.state.field(formatting.modeField)).toBe("formatted");
    view.destroy();
  });
});

describe("toggleBold", () => {
  it("wraps a selection in ** markers", () => {
    const { view } = createView("hello world");
    view.dispatch({ selection: EditorSelection.range(0, 5) });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("**hello** world");
    expect(view.state.selection.main).toEqual(EditorSelection.range(2, 7));
  });

  it("unwraps an already-bolded selection", () => {
    const { view } = createView("**hello** world");
    view.dispatch({ selection: EditorSelection.range(2, 7) });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("inserts an empty marker pair and places the cursor between them when there is no selection", () => {
    const { view } = createView("");
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("****");
    expect(view.state.selection.main.head).toBe(2);
  });

  it("removes the empty marker pair when toggled again at the cursor", () => {
    const { view } = createView("");
    toggleBold(view);
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("");
    expect(view.state.selection.main.head).toBe(0);
  });

  it("wraps each selected line in its own marker pair, skipping blank lines", () => {
    const { view } = createView("one\ntwo\n\nthree");
    view.dispatch({ selection: EditorSelection.range(0, 14) });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("**one**\n**two**\n\n**three**");
  });

  it("unwraps every line when the whole selection is already bold", () => {
    const { view } = createView("**one**\n**two**");
    view.dispatch({ selection: EditorSelection.range(0, 15) });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("one\ntwo");
  });

  it("wraps only the unwrapped lines of a mixed selection", () => {
    const { view } = createView("**one**\ntwo");
    view.dispatch({ selection: EditorSelection.range(0, 11) });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("**one**\n**two**");
  });

  it("keeps surrounding whitespace outside the inserted markers", () => {
    const { view } = createView("  padded  ");
    view.dispatch({ selection: EditorSelection.range(0, 10) });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("  **padded**  ");
    expect(view.state.selection.main).toEqual(EditorSelection.range(4, 10));
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("  padded  ");
  });

  it("round-trips a selection with trailing whitespace", () => {
    const { view } = createView("one two three");
    view.dispatch({ selection: EditorSelection.range(0, 4) });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("**one** two three");
    expect(view.state.selection.main).toEqual(EditorSelection.range(2, 5));
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("one two three");
  });
});

describe("toggleItalic", () => {
  it("wraps a selection in * markers", () => {
    const { view } = createView("hello world");
    view.dispatch({ selection: EditorSelection.range(0, 5) });
    toggleItalic(view);
    expect(view.state.doc.toString()).toBe("*hello* world");
  });

  it("unwraps an already-italicized selection", () => {
    const { view } = createView("*hello* world");
    view.dispatch({ selection: EditorSelection.range(1, 6) });
    toggleItalic(view);
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("removes the empty italic pair when toggled again at the cursor", () => {
    const { view } = createView("");
    toggleItalic(view);
    toggleItalic(view);
    expect(view.state.doc.toString()).toBe("");
    expect(view.state.selection.main.head).toBe(0);
  });

  it("does not create nested italic markup inside bold text", () => {
    const { view } = createView("**hello**");
    view.dispatch({ selection: EditorSelection.range(2, 7) });
    toggleItalic(view);
    expect(view.state.doc.toString()).toBe("**hello**");
  });
});

describe("setHeadingLevel", () => {
  it("adds a heading prefix to the current line", () => {
    const { view } = createView("Title");
    setHeadingLevel(view, 2);
    expect(view.state.doc.toString()).toBe("## Title");
  });

  it("clears the heading when re-applying the same level (toggle off)", () => {
    const { view } = createView("## Title");
    view.dispatch({ selection: EditorSelection.cursor(3) });
    setHeadingLevel(view, 2);
    expect(view.state.doc.toString()).toBe("Title");
  });

  it("replaces an existing heading level with a new one", () => {
    const { view } = createView("## Title");
    view.dispatch({ selection: EditorSelection.cursor(3) });
    setHeadingLevel(view, 4);
    expect(view.state.doc.toString()).toBe("#### Title");
  });

  it("clears the heading when level is 0", () => {
    const { view } = createView("### Title");
    setHeadingLevel(view, 0);
    expect(view.state.doc.toString()).toBe("Title");
  });

  it("applies the heading to every line the selection touches", () => {
    const { view } = createView("one\ntwo\nthree");
    view.dispatch({ selection: EditorSelection.range(0, 12) });
    setHeadingLevel(view, 1);
    expect(view.state.doc.toString()).toBe("# one\n# two\n# three");
  });

  it("is a no-op (returns false) when there is nothing to change", () => {
    const { view } = createView("Title");
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(setHeadingLevel(view, 0)).toBe(false);
    expect(view.state.doc.toString()).toBe("Title");
  });

  it("maps the cursor forward so it lands after the inserted prefix", () => {
    const { view } = createView("Title");
    view.dispatch({ selection: EditorSelection.cursor(0) });
    setHeadingLevel(view, 3);
    expect(view.state.selection.main.head).toBe(4);
  });
});
