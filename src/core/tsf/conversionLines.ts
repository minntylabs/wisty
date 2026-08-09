/**
 * Keeping ffmpeg's output bounded while a conversion runs.
 *
 * Most conversions say twenty lines and stop, but ffmpeg can warn once per
 * frame — `Queue input is backward in time` and its like — and the window
 * collects for as long as the conversion lasts. Holding all of it would grow
 * without limit and make every batch cost more than the last.
 *
 * The header is what the summary is read from, so the beginning is kept; the
 * end is what explains a failure, so the end is kept. What goes is the middle,
 * and it goes visibly: a line saying how much is missing is worth more than a
 * log that quietly lies about being complete.
 */

const HEADER_KEPT = 60;
const RECENT_KEPT = 240;
const ELISION = "… ";
const ELISION_SUFFIX = " earlier lines not shown …";

const isElision = (line: string) => line.startsWith(ELISION) && line.endsWith(ELISION_SUFFIX);

const elisionCount = (line: string): number =>
  isElision(line) ? Number(line.slice(ELISION.length, -ELISION_SUFFIX.length)) || 0 : 0;

export const appendConversionLines = (existing: string[], incoming: string[]): string[] => {
  // Its own marker comes out first, so the count it carries is not counted
  // twice and the marker is never mistaken for something ffmpeg said.
  const dropped = existing.reduce((total, line) => total + elisionCount(line), 0);
  const said = existing.filter((line) => !isElision(line)).concat(incoming);

  if (said.length <= HEADER_KEPT + RECENT_KEPT) {
    return dropped > 0
      ? [...said.slice(0, HEADER_KEPT), `${ELISION}${dropped}${ELISION_SUFFIX}`, ...said.slice(HEADER_KEPT)]
      : said;
  }

  const nowDropped = dropped + said.length - HEADER_KEPT - RECENT_KEPT;
  return [
    ...said.slice(0, HEADER_KEPT),
    `${ELISION}${nowDropped}${ELISION_SUFFIX}`,
    ...said.slice(said.length - RECENT_KEPT)
  ];
};
