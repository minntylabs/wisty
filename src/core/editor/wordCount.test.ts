import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countWordsInLines, createWordCounter } from "./wordCount";

describe("counting words", () => {
  const count = (text: string) => countWordsInLines(text.split("\n"));

  it("counts runs of non-whitespace", () => {
    expect(count("one two three")).toBe(3);
  });

  it("is not fooled by the spacing around them", () => {
    expect(count("  one   two  ")).toBe(2);
    expect(count("one\ttwo")).toBe(2);
    expect(count("")).toBe(0);
    expect(count("   ")).toBe(0);
  });

  it("counts across lines without joining the words either side of one", () => {
    expect(count("one\ntwo")).toBe(2);
    expect(count("one two\nthree four\n\nfive")).toBe(5);
  });

  /** The usual bargain for a status-bar count, stated so it is deliberate. */
  it("counts a hyphenated or apostrophised word once, and a lone dash as one", () => {
    expect(count("well-known")).toBe(1);
    expect(count("don't")).toBe(1);
    expect(count("a — b")).toBe(3);
  });

  it("treats a no-break space as the space it looks like", () => {
    expect(count("one two")).toBe(2);
  });
});

describe("the word counter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createCounter = (document: () => string[], options?: { sliceChars?: number }) => {
    const onCount = vi.fn();
    let reads = 0;
    const counter = createWordCounter({
      readLines: () => {
        reads += 1;
        return document();
      },
      onCount,
      quietMs: 100,
      sliceChars: options?.sliceChars ?? 1024
    });
    return { counter, onCount, reads: () => reads };
  };

  it("counts nothing until typing stops", async () => {
    const { counter, onCount } = createCounter(() => ["one two"]);

    counter.schedule();
    await vi.advanceTimersByTimeAsync(99);
    expect(onCount).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onCount).toHaveBeenCalledWith(2);
  });

  it("abandons a scan that a later edit has already made wrong", async () => {
    let lines = ["one two"];
    const { counter, onCount } = createCounter(() => lines);

    counter.schedule();
    await vi.advanceTimersByTimeAsync(50);
    lines = ["one two three"];
    counter.schedule();
    await vi.advanceTimersByTimeAsync(100);

    // Only the second scan reports, and it reports the document as it now is.
    expect(onCount).toHaveBeenCalledTimes(1);
    expect(onCount).toHaveBeenCalledWith(3);
  });

  /**
   * The point of the slicing: a document too large to scan at once is scanned
   * in pieces, and the editor has the thread back between them.
   */
  it("scans a long document in slices and still totals it correctly", async () => {
    const lines = Array.from({ length: 40 }, () => "alpha beta gamma delta");
    const { counter, onCount } = createCounter(() => lines, { sliceChars: 40 });

    counter.schedule();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    expect(onCount).toHaveBeenCalledWith(160);
  });

  it("does not report a count for a document that has been closed", async () => {
    const { counter, onCount } = createCounter(() => ["one two"]);

    counter.schedule();
    counter.cancel();
    await vi.runAllTimersAsync();

    expect(onCount).not.toHaveBeenCalled();
  });

  /**
   * A document expensive enough to be worth waiting for is waited for: the
   * scan's own cost sets how soon the next one may start, so a very large file
   * is not rescanned continuously while it is being edited.
   */
  it("waits longer before rescanning a document that was slow to scan", async () => {
    const lines = ["one two"];
    const { counter, onCount } = createCounter(() => lines);
    // The clock the counter reads charges the first scan 200ms: it is read once
    // as the slice begins and once as it ends.
    const readings = [0, 200];
    let reading = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => readings[Math.min(reading++, readings.length - 1)]
    );

    counter.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(onCount).toHaveBeenCalledTimes(1);

    counter.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(onCount).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(onCount).toHaveBeenCalledTimes(2);
  });
});

describe("a new document's count", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The backoff is a property of the document being counted, not of the
   * counter. Carrying it across would leave a small file waiting out the time
   * a large one had earned.
   */
  it("is not held behind the backoff the last document earned", async () => {
    const onCount = vi.fn();
    let lines = ["one two"];
    const counter = createWordCounter({
      readLines: () => lines,
      onCount,
      quietMs: 100,
      sliceChars: 1024
    });
    const readings = [0, 5_000];
    let reading = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => readings[Math.min(reading++, readings.length - 1)]
    );

    // A document expensive enough to earn a long wait before the next scan.
    counter.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(onCount).toHaveBeenLastCalledWith(2);

    // Then it is replaced by a small one.
    lines = ["only"];
    counter.invalidate();
    counter.schedule();
    await vi.advanceTimersByTimeAsync(100);

    expect(onCount).toHaveBeenLastCalledWith(1);
  });
});
