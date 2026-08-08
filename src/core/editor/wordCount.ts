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

/** A scan in progress, which may have stopped in the middle of a word. */
export type WordScan = {
  words: number;
  /** Whether the previous chunk ended inside a word rather than after one. */
  inWord: boolean;
};

export const EMPTY_SCAN: WordScan = { words: 0, inWord: false };

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
 * Counts the words in one line, continuing a scan.
 *
 * A word is a run of non-whitespace, which is what makes this cheap enough to
 * run over a very large document. It counts a hyphenated word once and "don't"
 * once, and any punctuation standing alone — an em dash between spaces — once
 * too, which is the usual bargain for a status-bar count.
 */
export const scanLine = (line: string, scan: WordScan): WordScan => {
  let { words } = scan;
  // Lines arrive separated, and a line break is whitespace: a word can never
  // continue across one, whatever the previous line ended with.
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
  return { words, inWord };
};

/** Counts a whole document held in memory. Used by tests and small documents. */
export const countWordsInLines = (lines: Iterable<string>): number => {
  let scan = EMPTY_SCAN;
  for (const line of lines) {
    scan = scanLine(line, scan);
  }
  return scan.words;
};

export type WordCounterDeps = {
  /** A fresh reader over the whole document, one line at a time. */
  readLines: () => Iterable<string>;
  onCount: (words: number) => void;
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
  const sliceChars = deps.sliceChars ?? DEFAULT_SLICE_CHARS;
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
    let scan = EMPTY_SCAN;
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
          deps.onCount(scan.words);
          return;
        }
        scan = scanLine(next.value, scan);
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

  return { schedule, cancel };
};
