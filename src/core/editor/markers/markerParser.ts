/**
 * Time markers for transcript files (.tsf), where each sentence is introduced
 * by an inline token carrying the span of audio it was transcribed from:
 *
 *     ALICE: ⟦734.12–736.80⟧So we walked down. ⟦736.80–740.15⟧And then it rained.
 *
 * The times are seconds from the start of the recording. Each token is
 * self-describing — start and end in one marker — so playing a sentence never
 * depends on a neighbouring marker still being present, and editing elsewhere
 * in the document cannot change what a marker means.
 *
 * Everything here is pure and works on plain strings, so the whole module is
 * testable without CodeMirror.
 */

export type Marker = {
  /** Document offsets of the whole token, brackets included. */
  from: number;
  to: number;
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
};

/**
 * Mathematical white square brackets (U+27E6/U+27E7) around two times joined by
 * an en dash (U+2013). Written as escapes rather than literals: all three
 * characters are easy to confuse with commoner lookalikes — ⟦ with [, – with a
 * hyphen — and a mismatch between what the generator writes and what this
 * matches would be invisible on the page.
 *
 * Deliberately strict about the number format. A damaged marker should fail to
 * match and show up as literal text, which is obviously wrong at a glance,
 * rather than matching loosely and pointing silently at the wrong audio.
 */
const MARKER_PATTERN = /⟦(\d+\.\d{2})–(\d+\.\d{2})⟧/g;

/**
 * A marker token for `start` and `end`, in seconds.
 *
 * The only sanctioned way to construct one. Everything that writes a marker
 * goes through here so the token's shape is defined once, beside the pattern
 * that reads it — the two are tested as a round trip. A second implementation
 * elsewhere (in the importer, or across the Rust bridge) could drift from this
 * one silently, and a marker that parses but means something else is the worst
 * failure this format allows.
 */
export const formatMarker = (start: number, end: number): string =>
  `⟦${start.toFixed(2)}–${end.toFixed(2)}⟧`;

/**
 * Every marker in `text`, in document order. `offset` is added to the reported
 * positions, so a caller holding a slice can report document coordinates.
 *
 * Transcripts are small — a 28-minute interview is tens of kilobytes with
 * 100-150 markers — so scanning the whole document is cheap enough that the
 * callers do it on every document change rather than tracking positions
 * incrementally.
 */
export const parseMarkers = (text: string, offset = 0): Marker[] => {
  const markers: Marker[] = [];
  // A fresh regex per call: the `g` flag makes lastIndex stateful, and sharing
  // one instance across calls would silently skip matches under re-entry.
  const pattern = new RegExp(MARKER_PATTERN.source, "g");

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    markers.push({
      from: offset + match.index,
      to: offset + match.index + match[0].length,
      start: Number(match[1]),
      end: Number(match[2])
    });
  }
  return markers;
};

/**
 * The text with every marker removed. Used when exporting a .tsf as plain
 * text, which deliberately discards the timings.
 */
export const stripMarkers = (text: string): string =>
  text.replace(new RegExp(MARKER_PATTERN.source, "g"), "");

/**
 * The marker containing `pos`, counting both edges as inside, or null. Callers
 * asking "is this position part of a marker" want the edges included; callers
 * asking "would an edit here damage a marker" want `splitsMarker` instead.
 */
export const markerAt = (markers: readonly Marker[], pos: number): Marker | null =>
  markers.find((marker) => pos >= marker.from && pos <= marker.to) ?? null;

/**
 * True when replacing the range [from, to) would leave a fragment of a marker
 * behind.
 *
 * Removing a marker whole is fine, and so is removing a range that happens to
 * contain one — deleting a speaker turn takes its markers with it, which is
 * ordinary editing. What must never happen is an edit that starts or ends
 * *inside* a token, because the remains would either parse as a different time
 * or stop parsing and become prose. That is the one silent failure available
 * here: a marker that still looks like a marker but points somewhere else.
 */
export const splitsMarker = (markers: readonly Marker[], from: number, to: number): boolean =>
  markers.some(
    (marker) =>
      (from > marker.from && from < marker.to) || (to > marker.from && to < marker.to)
  );

/**
 * `spans` with any part overlapping a marker removed, and spans that were
 * nothing but a marker dropped.
 *
 * Transcript tidy mode segments turns into words by splitting on whitespace,
 * which has no idea markers exist: a marker would be selected, highlighted and
 * reattributed to the other speaker as though it were a word. This is the
 * filter that prevents that, and it is also what leaves a click on a marker
 * unclaimed so the marker's own widget can receive it.
 */
export const excludeMarkers = <T extends { from: number; to: number }>(
  spans: readonly T[],
  markers: readonly Marker[]
): T[] => {
  if (markers.length === 0) {
    return [...spans];
  }
  return spans.flatMap((span) => {
    // What remains of the span once the markers are cut out of it. Usually one
    // piece, because a marker sits flush at the start of the word it introduces
    // — but a marker in the middle of a span splits it, and returning only the
    // leading piece would silently discard the text after it.
    let pieces = [{ from: span.from, to: span.to }];
    for (const marker of markers) {
      pieces = pieces.flatMap((piece) => {
        if (marker.to <= piece.from || marker.from >= piece.to) {
          return [piece];
        }
        const remaining: { from: number; to: number }[] = [];
        if (marker.from > piece.from) {
          remaining.push({ from: piece.from, to: marker.from });
        }
        if (marker.to < piece.to) {
          remaining.push({ from: marker.to, to: piece.to });
        }
        return remaining;
      });
    }
    return pieces.map((piece) => ({ ...span, ...piece }));
  });
};
