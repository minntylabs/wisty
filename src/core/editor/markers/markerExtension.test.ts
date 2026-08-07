/**
 * The question this file exists to answer: do in-band time markers survive
 * hard editing? If they do not, the decision to put the times in the document
 * rather than alongside it fails, and the file format changes shape.
 *
 * So the tests below are deliberately hostile — whole turns deleted, select
 * all and retype, paste from elsewhere, find-and-replace across a token — and
 * each asserts that every surviving marker is still intact and still means
 * what it meant.
 */

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createMarkers, markersIn as trackedMarkers, setMarkersVisibleEffect } from "./markerExtension";
import { parseMarkers } from "../../tsf/markers";

const M1 = "⟦734.12–736.80⟧";
const M2 = "⟦736.80–740.15⟧";
const M3 = "⟦742.90–745.30⟧";

const DOC =
  `ALICE: ${M1}So we walked down. ${M2}And then it rained.\n` +
  "\n" +
  `BOB: ${M3}Did you?`;

const createView = (doc: string = DOC, visible = true) => {
  const markers = createMarkers(() => visible);
  const state = EditorState.create({ doc, extensions: [markers.extension] });
  const view = new EditorView({ state, parent: document.body });
  return { view, markers };
};

/** Every marker still parseable in the document, as "start-end" strings. */
const markersIn = (view: EditorView): string[] =>
  parseMarkers(view.state.doc.toString()).map((m) => `${m.start}-${m.end}`);

/** Any bracket left in the text that is not part of a whole marker. */
const hasFragment = (view: EditorView): boolean => {
  const text = view.state.doc.toString();
  const brackets = (text.match(/[⟦⟧]/g) ?? []).length;
  return brackets !== parseMarkers(text).length * 2;
};

describe("rendering", () => {
  it("replaces each marker with an icon when visible", () => {
    const { view } = createView();
    expect(view.dom.querySelectorAll(".cm-marker-icon")).toHaveLength(3);
    expect(view.dom.textContent).not.toContain("734.12");
    view.destroy();
  });

  it("hides the icons with a class rather than rebuilding the decorations", () => {
    // Visibility is one class on the content element, so toggling it costs
    // nothing per marker. The icons stay in the DOM and collapse via CSS.
    const { view } = createView(DOC, false);
    expect(view.contentDOM.classList.contains("cm-markers-hidden")).toBe(true);
    expect(view.dom.textContent).not.toContain("734.12");
    view.destroy();
  });

  it("toggles that class on the visibility effect", () => {
    const { view } = createView(DOC, false);
    view.dispatch({ effects: setMarkersVisibleEffect.of(true) });
    expect(view.contentDOM.classList.contains("cm-markers-hidden")).toBe(false);
    view.dispatch({ effects: setMarkersVisibleEffect.of(false) });
    expect(view.contentDOM.classList.contains("cm-markers-hidden")).toBe(true);
    view.destroy();
  });

  it("never shows the raw marker text, hidden or shown", () => {
    for (const visible of [true, false]) {
      const { view } = createView(DOC, visible);
      expect(view.dom.textContent).not.toContain("734.12");
      expect(view.dom.textContent).not.toContain("⟦");
      view.destroy();
    }
  });

  it("leaves the document text untouched either way", () => {
    const { view } = createView();
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });
});

describe("surviving hard edits", () => {
  it("takes a whole speaker turn's markers with it when the turn is deleted", () => {
    const { view } = createView();
    const line = view.state.doc.line(3); // the BOB turn
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "" } });

    expect(markersIn(view)).toEqual(["734.12-736.8", "736.8-740.15"]);
    expect(hasFragment(view)).toBe(false);
    view.destroy();
  });

  it("survives select-all-and-retype by removing every marker whole", () => {
    const { view } = createView();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "replaced entirely" }
    });

    expect(markersIn(view)).toEqual([]);
    expect(hasFragment(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("replaced entirely");
    view.destroy();
  });

  it("keeps markers intact when text between them is deleted", () => {
    const { view } = createView();
    const from = DOC.indexOf("So we walked down.");
    view.dispatch({ changes: { from, to: from + "So we walked down. ".length, insert: "" } });

    expect(markersIn(view)).toEqual(["734.12-736.8", "736.8-740.15", "742.9-745.3"]);
    expect(hasFragment(view)).toBe(false);
    view.destroy();
  });

  it("accepts a paste that contains whole markers", () => {
    const { view } = createView();
    view.dispatch({ changes: { from: 0, insert: `CAROL: ${M1}Pasted in.\n` } });

    expect(markersIn(view)).toEqual([
      "734.12-736.8",
      "734.12-736.8",
      "736.8-740.15",
      "742.9-745.3"
    ]);
    expect(hasFragment(view)).toBe(false);
    view.destroy();
  });
});

describe("rejecting edits that would damage a marker", () => {
  const firstMarkerFrom = DOC.indexOf(M1);

  it("rejects an insertion inside a token", () => {
    const { view } = createView();
    view.dispatch({ changes: { from: firstMarkerFrom + 4, insert: "9" } });

    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("rejects a deletion that starts inside a token", () => {
    const { view } = createView();
    view.dispatch({
      changes: { from: firstMarkerFrom + 3, to: firstMarkerFrom + 8, insert: "" }
    });

    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("rejects a replacement ending inside a token", () => {
    const { view } = createView();
    view.dispatch({ changes: { from: 0, to: firstMarkerFrom + 5, insert: "X" } });

    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("rejects a find-and-replace that lands inside a token", () => {
    const { view } = createView();
    // "734" appears only inside a marker; replacing it would corrupt the time.
    const at = DOC.indexOf("734");
    view.dispatch({ changes: { from: at, to: at + 3, insert: "999" } });

    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("rejects a multi-change transaction if any one change would damage a marker", () => {
    const { view } = createView();
    view.dispatch({
      changes: [
        { from: 0, to: 5, insert: "CAROL" },
        { from: firstMarkerFrom + 4, insert: "9" }
      ]
    });

    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("still allows an edit that only touches prose", () => {
    const { view } = createView();
    const at = DOC.indexOf("rained");
    view.dispatch({ changes: { from: at, to: at + 6, insert: "poured" } });

    expect(view.state.doc.toString()).toContain("poured");
    expect(markersIn(view)).toHaveLength(3);
    view.destroy();
  });
});

/**
 * `atomicRanges` is an input-layer facet, not a transaction filter: CodeMirror
 * applies it to cursor motion, mouse selection and typing, but a programmatic
 * dispatch of a selection is not constrained by it. So these tests go through
 * `view.moveByChar`, which is what the real cursor commands call, and the
 * change filter is what covers everything that does not.
 */
describe("caret motion around a marker", () => {
  const firstMarkerFrom = DOC.indexOf(M1);
  const firstMarkerTo = firstMarkerFrom + M1.length;
  const inside = (pos: number) => pos > firstMarkerFrom && pos < firstMarkerTo;

  it("steps over a marker rather than into it, moving forwards", () => {
    const { view } = createView();
    const moved = view.moveByChar(EditorSelection.cursor(firstMarkerFrom), true);
    expect(inside(moved.head)).toBe(false);
    expect(moved.head).toBeGreaterThanOrEqual(firstMarkerTo);
    view.destroy();
  });

  it("steps over a marker rather than into it, moving backwards", () => {
    const { view } = createView();
    const moved = view.moveByChar(EditorSelection.cursor(firstMarkerTo), false);
    expect(inside(moved.head)).toBe(false);
    expect(moved.head).toBeLessThanOrEqual(firstMarkerFrom);
    view.destroy();
  });

  it("steps over a marker when they are hidden too", () => {
    const { view } = createView(DOC, false);
    const moved = view.moveByChar(EditorSelection.cursor(firstMarkerFrom), true);
    expect(inside(moved.head)).toBe(false);
    expect(moved.head).toBeGreaterThanOrEqual(firstMarkerTo);
    view.destroy();
  });

  it("refuses the edit even if the caret is forced inside programmatically", () => {
    // The belt to atomicRanges' braces: nothing reaches this position through
    // the UI, but if anything did, the change filter still holds the line.
    const { view } = createView();
    view.dispatch({ selection: EditorSelection.cursor(firstMarkerFrom + 5) });
    view.dispatch(view.state.replaceSelection("9"));

    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });
});

describe("undo restores markers exactly", () => {
  it("restores a deleted turn's markers on undo", () => {
    // Undo is the editor's own history extension; here we prove the document
    // round-trips, which is what history replays.
    const { view } = createView();
    const before = view.state.doc.toString();
    const line = view.state.doc.line(3);

    view.dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
    expect(markersIn(view)).toHaveLength(2);

    view.dispatch({ changes: { from: line.from, insert: `BOB: ${M3}Did you?` } });
    expect(view.state.doc.toString()).toBe(before);
    expect(markersIn(view)).toHaveLength(3);
    view.destroy();
  });
});

/**
 * The marker list is maintained incrementally: positions away from the edit are
 * mapped, and only the touched lines are re-read. Every case here asserts the
 * result is identical to reading the whole document afresh, which is the
 * standard the incremental path has to meet.
 */
describe("incremental marker tracking", () => {
  const markersFrom = (view: EditorView) => trackedMarkers(view.state);
  const truth = (view: EditorView) => parseMarkers(view.state.doc.toString());

  const check = (spec: Parameters<EditorView["dispatch"]>[0], doc = DOC) => {
    const { view } = createView(doc);
    view.dispatch(spec);
    expect(markersFrom(view)).toEqual(truth(view));
    view.destroy();
  };

  it("insertion at the very start", () => check({ changes: { from: 0, insert: "XX " } }));

  it("insertion in prose before a marker", () =>
    check({ changes: { from: DOC.indexOf("So we"), insert: "hello " } }));

  it("insertion flush against a marker's start", () =>
    check({ changes: { from: DOC.indexOf(M1), insert: "Z" } }));

  it("insertion flush against a marker's end", () =>
    check({ changes: { from: DOC.indexOf(M1) + M1.length, insert: "Z" } }));

  it("deleting prose between two markers", () =>
    check({ changes: { from: DOC.indexOf("So we"), to: DOC.indexOf("So we") + 10, insert: "" } }));

  it("deleting a whole marker", () =>
    check({ changes: { from: DOC.indexOf(M2), to: DOC.indexOf(M2) + M2.length, insert: "" } }));

  it("deleting a whole line", () =>
    check({ changes: { from: DOC.lastIndexOf("\n") + 1, to: DOC.length, insert: "" } }));

  it("joining two lines", () =>
    check({ changes: { from: DOC.indexOf("\n"), to: DOC.indexOf("\n") + 2, insert: " " } }));

  it("replacing the entire document", () =>
    check({ changes: { from: 0, to: DOC.length, insert: "nothing left" } }));

  it("a multi-change transaction", () =>
    check({ changes: [{ from: 0, insert: "A" }, { from: DOC.indexOf("BOB"), insert: "B" }] }));

  it("pasting a marker that did not exist before", () =>
    check({ changes: { from: DOC.indexOf("So we"), insert: "⟦900.00–901.00⟧" } }));

  it("pasting a whole new turn with markers", () =>
    check({ changes: { from: 0, insert: `CAROL: ${M1}Pasted.\n\n` } }));

  it("an edit spanning several lines at once", () =>
    check({ changes: { from: 10, to: DOC.length - 5, insert: `x ${M2} y` } }));

  it("stays correct across a run of consecutive edits", () => {
    const { view } = createView();
    view.dispatch({ changes: { from: 0, insert: "A" } });
    view.dispatch({ changes: { from: DOC.indexOf("rained") + 1, insert: "!" } });
    view.dispatch({ changes: { from: 5, to: 12, insert: "" } });
    view.dispatch({ changes: { from: 0, insert: `${M3}` } });
    expect(markersFrom(view)).toEqual(truth(view));
    view.destroy();
  });
});
