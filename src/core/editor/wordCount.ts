/**
 * Counting the words in the document without stopping the editor.
 *
 * A word count is a whole-document question, and this editor opens documents up
 * to a gigabyte. Measured on this machine a scan runs at roughly two
 * milliseconds per megabyte: nothing at all for ordinary files, a tenth of a
 * second at the fifty-megabyte soft limit, and around two seconds at the hard
 * one. Recounting inline on every keystroke would therefore be fine right up
 * until it was catastrophic.
 *
 * So the count is never taken inline. It is taken after typing stops, in slices
 * that hand control back between them, and abandoned the moment the document
 * changes again — a scan in flight is worthless once its subject has moved.
 * Each scan reads the document afresh rather than adjusting the last answer,
 * which costs more than tracking edits would but cannot drift: an error in
 * counting a single edit would otherwise sit in the total until the file was
 * closed.
 */

const isWhitespace = (code: number) =>
  code === 32 // space
  || code === 9 // tab
  || code === 10 // line feed
  || code === 13 // carriage return
  || code === 12 // form feed
  || code === 11 // vertical tab
  || code === 0x00a0 // no-break space
  || code === 0x2028 // line separator
  || code === 0x2029 // paragraph separator
  || code === 0x3000; // ideographic space

/**
 * Counts the words in one line.
 *
 * A word is a run of non-whitespace, which is what makes this cheap enough to
 * run over a very large document. It counts a hyphenated word once and "don't"
 * once, and any punctuation standing alone — an em dash between spaces — once
 * too, which is the usual bargain for a status-bar count.
 *
 * A line is counted on its own because a line break is whitespace: no word
 * carries from one line into the next, so there is no state between them.
 */
export const countWordsInLine = (line: string): number => {
  let words = 0;
  let inWord = false;
  for (let index = 0; index < line.length; index += 1) {
    if (isWhitespace(line.charCodeAt(index))) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      inWord = true;
      words += 1;
    }
  }
  return words;
};

/** Counts a whole document that is already to hand. Used by the tests. */
export const countWordsInLines = (lines: Iterable<string>): number => {
  let words = 0;
  for (const line of lines) {
    words += countWordsInLine(line);
  }
  return words;
};

export type WordCounterDeps = {
  /** A fresh reader over the whole document, one line at a time. */
  readLines: () => Iterable<string>;
  /** `null` when the count is not known: the document has been replaced. */
  onCount: (words: number | null) => void;
  /** Characters to scan before handing control back. */
  sliceChars?: number;
  /** How long typing must stop before a scan starts. */
  quietMs?: number;
};

const DEFAULT_SLICE_CHARS = 1024 * 1024;
const DEFAULT_QUIET_MS = 400;
/**
 * A scan may not cost more than a fifth of the time between scans, so a
 * document large enough to be expensive is counted less often rather than
 * continuously. At two milliseconds per megabyte a gigabyte waits about ten
 * seconds after each pause in typing; a normal file waits the quiet period.
 */
const IDLE_COST_RATIO = 5;
const MAX_QUIET_MS = 30_000;

export const createWordCounter = (deps: WordCounterDeps) => {
  // At least one character per slice, or a slice would consume no lines and
  // reschedule itself for ever.
  const sliceChars = Math.max(1, deps.sliceChars ?? DEFAULT_SLICE_CHARS);
  const quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;

  /** Invalidates a scan and any timer belonging to an earlier document. */
  let generation = 0;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let sliceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastScanMs = 0;

  const clearTimers = () => {
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (sliceTimer !== null) {
      clearTimeout(sliceTimer);
      sliceTimer = null;
    }
  };

  const runScan = (scanGeneration: number) => {
    const lines = deps.readLines()[Symbol.iterator]();
    let words = 0;
    let elapsedMs = 0;

    const runSlice = () => {
      sliceTimer = null;
      if (scanGeneration !== generation) {
        return;
      }
      const startedAt = Date.now();
      let scanned = 0;
      while (scanned < sliceChars) {
        const next = lines.next();
        if (next.done) {
          elapsedMs += Date.now() - startedAt;
          lastScanMs = elapsedMs;
          deps.onCount(words);
          return;
        }
        words += countWordsInLine(next.value);
        scanned += next.value.length + 1;
      }
      elapsedMs += Date.now() - startedAt;
      // More to read: give the editor the thread back before continuing.
      sliceTimer = setTimeout(runSlice, 0);
    };

    runSlice();
  };

  /**
   * Asks for a fresh count once typing stops. Any scan already running or
   * waiting is abandoned: it was counting a document that no longer exists.
   */
  const schedule = () => {
    generation += 1;
    const scanGeneration = generation;
    clearTimers();
    const delay = Math.min(MAX_QUIET_MS, Math.max(quietMs, lastScanMs * IDLE_COST_RATIO));
    quietTimer = setTimeout(() => {
      quietTimer = null;
      runScan(scanGeneration);
    }, delay);
  };

  const cancel = () => {
    generation += 1;
    clearTimers();
  };

  /**
   * Forgets the count because the document it described is gone.
   *
   * Without this the last document's total stays on screen until the new one
   * has been counted — which for a large file is seconds of a confidently
   * displayed wrong number, and for a document replaced by an empty one is
   * indefinite, since replacing the state outright produces no edit to count.
   */
  const invalidate = () => {
    cancel();
    deps.onCount(null);
  };

  return { schedule, cancel, invalidate };
};
