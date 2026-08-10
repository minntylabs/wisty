import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { history, undo } from "@codemirror/commands";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createMarkers } from "../markers/markerExtension";
import { createTranscriptExtension } from "./transcriptExtension";

const SAMPLE = "ALICE: so I went there and then he said\nBOB: it was fine";

/**
 * jsdom has no layout, so the handlers' coordinate lookups are stubbed and the
 * pointer position is supplied directly. Everything else — the anchor field,
 * the wheel accumulator, the commit transactions — runs for real.
 */
const createView = (doc = SAMPLE, extra: Extension = []) => {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [history(), createTranscriptExtension(), extra]
    }),
    parent: document.body
  });

  let pointerPos: number | null = null;
  let contentRect = new DOMRect(0, 0, 500, 500);
  // posAtCoords is overloaded (one signature never returns null), so the stub
  // is asserted rather than inferred.
  view.posAtCoords = ((): number | null => pointerPos) as typeof view.posAtCoords;
  view.coordsAtPos = () => null;
  view.contentDOM.getBoundingClientRect = () => contentRect;

  const at = (pos: number | null) => {
    pointerPos = pos;
  };

  const fire = <T extends Event>(event: T): T => {
    view.contentDOM.dispatchEvent(event);
    return event;
  };

  return {
    view,
    hover(pos: number | null) {
      at(pos);
      fire(new MouseEvent("mousemove", { bubbles: true }));
    },
    hoverAt(pos: number | null, clientX: number, clientY: number) {
      at(pos);
      fire(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }));
    },
    setContentRect(rect: DOMRect) {
      contentRect = rect;
    },
    wheel(deltaY: number) {
      return fire(new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true }));
    },
    click(pos: number) {
      at(pos);
      fire(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
    },
    rightClick(pos: number) {
      at(pos);
      fire(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true }));
    },
    selected: () => {
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
    text: () => view.state.doc.toString()
  };
};

describe("hover anchoring", () => {
  it("selects the word under the pointer", () => {
    const t = createView();
    t.hover(13);
    expect(t.selected()).toBe("went");
    t.view.destroy();
  });

  it("re-anchors freely while only the anchor word is selected", () => {
    const t = createView();
    t.hover(13);
    t.hover(36);
    expect(t.selected()).toBe("said");
    t.view.destroy();
  });

  it("selects the speaker label as an atomic unit, excluding its trailing gap", () => {
    const t = createView();
    t.hover(3);
    expect(t.selected()).toBe("ALICE:");
    t.view.destroy();
  });

  it("clears the selection when the pointer leaves the text", () => {
    const t = createView();
    t.hover(13);
    t.hover(null);
    expect(t.selected()).toBe("");
    t.view.destroy();
  });

  it("does not anchor when the pointer is in content padding above or left of text", () => {
    const t = createView();
    t.setContentRect(new DOMRect(20, 30, 500, 500));
    t.hoverAt(3, 10, 40);
    expect(t.selected()).toBe("");
    t.hoverAt(3, 30, 20);
    expect(t.selected()).toBe("");
    t.view.destroy();
  });

  it("does not anchor on a line that is not a turn", () => {
    const t = createView("just some prose\nALICE: hello");
    t.hover(4);
    expect(t.selected()).toBe("");
    t.view.destroy();
  });
});

describe("wheel extension", () => {
  it("extends forward on scroll down and backward on scroll up, crossing zero", () => {
    const t = createView();
    t.hover(13);
    t.wheel(50);
    expect(t.selected()).toBe("went there");
    t.wheel(-50);
    expect(t.selected()).toBe("went");
    t.wheel(-50);
    expect(t.selected()).toBe("I went");
    t.view.destroy();
  });

  it("accumulates sub-threshold travel instead of stepping per event", () => {
    const t = createView();
    t.hover(13);
    t.wheel(20);
    expect(t.selected()).toBe("went");
    t.wheel(20);
    expect(t.selected()).toBe("went");
    t.wheel(20);
    expect(t.selected()).toBe("went there");
    t.view.destroy();
  });

  it("stops at the turn boundary and never absorbs the label", () => {
    const t = createView();
    t.hover(13);
    t.wheel(-1000);
    expect(t.selected()).toBe("so I went");
    t.wheel(5000);
    expect(t.selected()).toBe("went there and then he said");
    t.view.destroy();
  });

  it("freezes the anchor once more than one word is selected", () => {
    const t = createView();
    t.hover(13);
    t.wheel(50);
    t.hover(46);
    expect(t.selected()).toBe("went there");
    t.view.destroy();
  });

  it("does nothing at all while a label is anchored", () => {
    const t = createView();
    t.hover(3);
    const event = t.wheel(200);
    expect(t.selected()).toBe("ALICE:");
    expect(event.defaultPrevented).toBe(true);
    t.view.destroy();
  });

  it("lets the document scroll when the pointer is not over a turn", () => {
    const t = createView();
    t.hover(null);
    expect(t.wheel(200).defaultPrevented).toBe(false);
    t.view.destroy();
  });

  it("consumes the wheel while a word is anchored", () => {
    const t = createView();
    t.hover(13);
    expect(t.wheel(200).defaultPrevented).toBe(true);
    t.view.destroy();
  });
});

describe("click commits", () => {
  it("moves a selection reaching the turn end into the next turn", () => {
    const t = createView();
    t.hover(36);
    t.click(36);
    expect(t.text()).toBe("ALICE: so I went there and then he\nBOB: said it was fine");
    t.view.destroy();
  });

  it("moves a selection reaching the turn start into the previous turn", () => {
    const t = createView();
    t.hover(46);
    t.click(46);
    expect(t.text()).toBe("ALICE: so I went there and then he said it\nBOB: was fine");
    t.view.destroy();
  });

  it("splits the turn in three when the selection reaches neither end", () => {
    const t = createView();
    t.hover(13);
    t.click(13);
    expect(t.text()).toBe(
      "ALICE: so I\nBOB: went\nALICE: there and then he said\nBOB: it was fine"
    );
    t.view.destroy();
  });

  it("does nothing when the whole turn is selected", () => {
    const t = createView();
    t.hover(46);
    t.wheel(500);
    expect(t.selected()).toBe("it was fine");
    t.click(46);
    expect(t.text()).toBe(SAMPLE);
    t.view.destroy();
  });

  it("commits as a single undo step", () => {
    const t = createView();
    t.hover(13);
    t.click(13);
    expect(t.text()).not.toBe(SAMPLE);
    undo(t.view);
    expect(t.text()).toBe(SAMPLE);
    t.view.destroy();
  });
});

describe("label operations", () => {
  it("left-click merges the turn into the one above", () => {
    const t = createView();
    t.hover(42);
    t.click(42);
    expect(t.text()).toBe("ALICE: so I went there and then he said it was fine");
    t.view.destroy();
  });

  it("right-click deletes the whole turn", () => {
    const t = createView();
    t.hover(42);
    t.rightClick(42);
    expect(t.text()).toBe("ALICE: so I went there and then he said");
    t.view.destroy();
  });

  it("left-click on the first turn's label does nothing", () => {
    const t = createView();
    t.hover(3);
    t.click(3);
    expect(t.text()).toBe(SAMPLE);
    t.view.destroy();
  });

  it("right-click elsewhere is left to other handlers", () => {
    const t = createView();
    t.hover(13);
    const event = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
    t.view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(t.text()).toBe(SAMPLE);
    t.view.destroy();
  });
});

describe("blank-line separated transcripts", () => {
  const SPACED = "ALICE: so I went there and then he said\n\nBOB: it was fine";
  const THREE = "ALICE: a\n\nBOB: b\n\nALICE: c";

  it("keeps one blank line between the turns a split creates", () => {
    const t = createView(SPACED);
    t.hover(13);
    t.click(13);
    expect(t.text()).toBe(
      "ALICE: so I\n\nBOB: went\n\nALICE: there and then he said\n\nBOB: it was fine"
    );
    t.view.destroy();
  });

  it("collapses the doubled blank line a turn deletion would leave", () => {
    const t = createView(THREE);
    t.hover(12);
    t.rightClick(12);
    expect(t.text()).toBe("ALICE: a\n\nALICE: c");
    t.view.destroy();
  });

  it("collapses the doubled blank line a label merge would leave", () => {
    const t = createView(THREE);
    t.hover(12);
    t.click(12);
    expect(t.text()).toBe("ALICE: a b\n\nALICE: c");
    t.view.destroy();
  });

  it("leaves spacing untouched for moves that do not change the line count", () => {
    const t = createView(SPACED);
    t.hover(36);
    t.click(36);
    expect(t.text()).toBe("ALICE: so I went there and then he\n\nBOB: said it was fine");
    t.view.destroy();
  });

  it("repairs spacing in the same undo step as the edit", () => {
    const t = createView(THREE);
    t.hover(12);
    t.rightClick(12);
    undo(t.view);
    expect(t.text()).toBe(THREE);
    t.view.destroy();
  });

  it("does not reflow a densely packed transcript", () => {
    const t = createView();
    t.hover(13);
    t.click(13);
    expect(t.text()).toBe(
      "ALICE: so I\nBOB: went\nALICE: there and then he said\nBOB: it was fine"
    );
    t.view.destroy();
  });
});

describe("decorations", () => {
  const IGNORED = new Set(["cm-transcript-sel", "cm-transcript-hint"]);

  const outcomeClass = (view: EditorView) =>
    [...view.dom.querySelectorAll("span")]
      .flatMap((span) => [...span.classList])
      .find((name) => name.startsWith("cm-transcript-") && !IGNORED.has(name));

  it("marks the outcome a click would have", () => {
    const t = createView();
    t.hover(36);
    expect(outcomeClass(t.view)).toBe("cm-transcript-toNext");
    t.hover(13);
    expect(outcomeClass(t.view)).toBe("cm-transcript-split");
    t.hover(46);
    expect(outcomeClass(t.view)).toBe("cm-transcript-toPrevious");
    t.view.destroy();
  });

  it("marks an inert selection distinctly from an actionable one", () => {
    const t = createView();
    t.hover(46);
    t.wheel(500);
    expect(outcomeClass(t.view)).toBe("cm-transcript-none");
    t.view.destroy();
  });

  it("marks a label selection with its own treatment", () => {
    const t = createView();
    t.hover(42);
    expect(outcomeClass(t.view)).toBe("cm-transcript-label");
    t.view.destroy();
  });
});

/**
 * Tidy mode and time markers configured together, which is what a .tsf gets.
 *
 * Both visibility states are exercised because "works with the icons shown,
 * breaks with them hidden" is the kind of bug that survives a review. It should
 * make no difference — visibility is a class on the content element, and the
 * tokens are in the buffer either way — and this is what says so.
 */
describe("alongside time markers", () => {
  // "ALICE: " is 7 characters, the marker is a further 15, so "So" begins at 22.
  const MARKED = "ALICE: ⟦734.12–736.80⟧So we walked\nBOB: it was fine";
  const MARKER_MIDDLE = 14;
  const SO = 23;

  const withMarkers = (visible: boolean) => createView(MARKED, createMarkers({ getInitialVisible: () => visible, onMarkerClick: () => {}, onStop: () => {} }).extension);

  for (const visible of [true, false]) {
    const state = visible ? "shown" : "hidden";

    it(`selects the word a marker introduces, not the marker with it (icons ${state})`, () => {
      const t = withMarkers(visible);
      t.hover(SO);
      expect(t.selected()).toBe("So");
      t.view.destroy();
    });

    it(`anchors nothing over a marker, leaving the click for its icon (icons ${state})`, () => {
      const t = withMarkers(visible);
      t.hover(MARKER_MIDDLE);
      expect(t.selected()).toBe("");
      t.view.destroy();
    });
  }
});

/**
 * The hint glyph is an inline widget, so by default it is a character in the
 * line: it widened the line, pushed the following words along and could rewrap
 * the paragraph, all while the pointer was merely hovering. Text moving under
 * the pointer is bad anywhere and worse in a mode whose clicks rewrite the
 * document.
 *
 * Asserted by reading the rule rather than by measuring, because jsdom does no
 * layout — every width it reports is zero, so a measuring test would pass
 * whatever the stylesheet said.
 */
describe("the hint takes up no room in the line", () => {
  const source = readFileSync(join(__dirname, "transcriptExtension.ts"), "utf8");
  const rule = source.slice(
    source.indexOf('".cm-transcript-hint": {'),
    source.indexOf("}", source.indexOf('".cm-transcript-hint": {'))
  );

  it("declares no width", () => {
    expect(rule).toContain('width: "0"');
  });

  it("still paints outside that box", () => {
    expect(rule).toContain('overflow: "visible"');
  });

  it("adds no margin, which on a zero-width box is width again", () => {
    expect(rule).not.toMatch(/margin/i);
  });

  it("is lifted clear of the text it now overlaps", () => {
    expect(rule).toMatch(/top: "-[\d.]+em"/);
  });
});
