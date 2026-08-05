import { describe, expect, it } from "vitest";
import {
  excludeMarkers,
  formatMarker,
  markerAt,
  parseMarkers,
  splitsMarker,
  stripMarkers
} from "./markerParser";

const MARKER = "⟦734.12–736.80⟧";

describe("formatMarker", () => {
  it("writes the token the pattern reads", () => {
    expect(formatMarker(734.12, 736.8)).toBe(MARKER);
  });

  it("always writes two decimal places", () => {
    expect(formatMarker(0, 5)).toBe("⟦0.00–5.00⟧");
    expect(formatMarker(1.5, 2.456)).toBe("⟦1.50–2.46⟧");
  });

  it("refuses non-finite times rather than writing an unparseable token", () => {
    expect(() => formatMarker(NaN, 1)).toThrow(RangeError);
    expect(() => formatMarker(1, Infinity)).toThrow(RangeError);
    expect(() => formatMarker(-Infinity, 1)).toThrow(RangeError);
  });

  it("round-trips through parseMarkers", () => {
    for (const [start, end] of [
      [0, 0.5],
      [734.12, 736.8],
      [1709.6, 1709.62],
      [12.005, 13.999]
    ]) {
      const parsed = parseMarkers(formatMarker(start, end));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].start).toBeCloseTo(start, 1);
      expect(parsed[0].end).toBeCloseTo(end, 1);
    }
  });
});

describe("parseMarkers", () => {
  it("reads start and end times and the token's extent", () => {
    const markers = parseMarkers(`ALICE: ${MARKER}So we walked down.`);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ from: 7, to: 7 + MARKER.length, start: 734.12, end: 736.8 });
  });

  it("reads every marker in document order", () => {
    const markers = parseMarkers(`${MARKER}One. ⟦736.80–740.15⟧Two. ⟦742.90–745.30⟧Three.`);
    expect(markers.map((m) => m.start)).toEqual([734.12, 736.8, 742.9]);
  });

  it("applies the offset so a slice can report document coordinates", () => {
    const markers = parseMarkers(MARKER, 100);
    expect(markers[0]).toMatchObject({ from: 100, to: 100 + MARKER.length });
  });

  it("is not confused by repeated calls (the global flag is not shared)", () => {
    const text = `${MARKER}One.`;
    expect(parseMarkers(text)).toHaveLength(1);
    expect(parseMarkers(text)).toHaveLength(1);
  });

  it("ignores square brackets, which speaker labels already reserve", () => {
    expect(parseMarkers("[00:12:14] ALICE: hello")).toEqual([]);
  });

  it("ignores a hyphen in place of the en dash", () => {
    expect(parseMarkers("⟦734.12-736.80⟧")).toEqual([]);
  });

  it("ignores damaged tokens rather than matching them loosely", () => {
    // Each of these should read as literal text, visibly wrong on the page.
    expect(parseMarkers("⟦734.1–736.80⟧")).toEqual([]);
    expect(parseMarkers("⟦734.123–736.80⟧")).toEqual([]);
    expect(parseMarkers("⟦734.12–736.80")).toEqual([]);
    expect(parseMarkers("734.12–736.80⟧")).toEqual([]);
    expect(parseMarkers("⟦–736.80⟧")).toEqual([]);
  });

  it("does not match across a line break", () => {
    expect(parseMarkers("⟦734.12\n–736.80⟧")).toEqual([]);
  });
});

describe("stripMarkers", () => {
  it("removes markers and leaves the prose untouched", () => {
    expect(stripMarkers(`ALICE: ${MARKER}So we walked down. ⟦736.80–740.15⟧And then.`)).toBe(
      "ALICE: So we walked down. And then."
    );
  });

  it("leaves text with no markers alone", () => {
    expect(stripMarkers("ALICE: nothing to strip")).toBe("ALICE: nothing to strip");
  });
});

describe("markerAt", () => {
  const markers = parseMarkers(`ALICE: ${MARKER}So we walked down.`);

  it("finds a marker from inside it", () => {
    expect(markerAt(markers, 10)?.start).toBe(734.12);
  });

  it("counts both edges as inside", () => {
    expect(markerAt(markers, 7)).not.toBeNull();
    expect(markerAt(markers, 7 + MARKER.length)).not.toBeNull();
  });

  it("returns null outside any marker", () => {
    expect(markerAt(markers, 0)).toBeNull();
    expect(markerAt(markers, 40)).toBeNull();
  });
});

describe("splitsMarker", () => {
  const text = `ALICE: ${MARKER}So we walked down.`;
  const markers = parseMarkers(text);
  const from = markers[0].from;
  const to = markers[0].to;

  it("allows removing a marker whole", () => {
    expect(splitsMarker(markers, from, to)).toBe(false);
  });

  it("allows removing a range that contains a marker", () => {
    expect(splitsMarker(markers, 0, text.length)).toBe(false);
  });

  it("allows edits either side of a marker", () => {
    expect(splitsMarker(markers, 0, from)).toBe(false);
    expect(splitsMarker(markers, to, text.length)).toBe(false);
  });

  it("rejects an edit starting inside a marker", () => {
    expect(splitsMarker(markers, from + 3, text.length)).toBe(true);
  });

  it("rejects an edit ending inside a marker", () => {
    expect(splitsMarker(markers, 0, to - 3)).toBe(true);
  });

  it("rejects an insertion inside a marker", () => {
    expect(splitsMarker(markers, from + 3, from + 3)).toBe(true);
  });
});

describe("excludeMarkers", () => {
  it("trims a span that starts with a marker", () => {
    // "⟦…⟧So" as tidy mode's whitespace split would see it.
    const markers = parseMarkers(`${MARKER}So`);
    const spans = [{ from: 0, to: MARKER.length + 2 }];
    expect(excludeMarkers(spans, markers)).toEqual([{ from: MARKER.length, to: MARKER.length + 2 }]);
  });

  it("drops a span that is nothing but a marker", () => {
    const markers = parseMarkers(MARKER);
    expect(excludeMarkers([{ from: 0, to: MARKER.length }], markers)).toEqual([]);
  });

  it("leaves spans clear of any marker untouched", () => {
    const markers = parseMarkers(`${MARKER}So`);
    const spans = [{ from: MARKER.length, to: MARKER.length + 2 }];
    expect(excludeMarkers(spans, markers)).toEqual(spans);
  });

  it("preserves other properties on the span", () => {
    const markers = parseMarkers(`${MARKER}So`);
    const spans = [{ from: 0, to: MARKER.length + 2, index: 3 }];
    expect(excludeMarkers(spans, markers)[0]).toMatchObject({ index: 3 });
  });

  it("splits a span around a marker in its middle rather than truncating it", () => {
    const text = `word${MARKER}more`;
    const markers = parseMarkers(text);
    expect(excludeMarkers([{ from: 0, to: text.length }], markers)).toEqual([
      { from: 0, to: 4 },
      { from: 4 + MARKER.length, to: text.length }
    ]);
  });

  it("removes several markers from one span", () => {
    const text = `${MARKER}a${MARKER}b`;
    const markers = parseMarkers(text);
    expect(excludeMarkers([{ from: 0, to: text.length }], markers)).toEqual([
      { from: MARKER.length, to: MARKER.length + 1 },
      { from: MARKER.length * 2 + 1, to: text.length }
    ]);
  });

  it("returns the spans unchanged when there are no markers", () => {
    const spans = [{ from: 0, to: 5 }];
    expect(excludeMarkers(spans, [])).toEqual(spans);
  });
});
