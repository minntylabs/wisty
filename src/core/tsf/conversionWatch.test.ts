import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversionWatch, type ConversionOutput } from "./conversionWatch";

const said = (...lines: string[]): ConversionOutput => ({
  lines,
  durationSecs: null,
  positionSecs: null,
  running: true
});

describe("watching a conversion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (batches: string[][]) => {
    const seen: string[] = [];
    let call = 0;
    const takeOutput = vi.fn(async () => said(...(batches[call++] ?? [])));
    const watch = createConversionWatch({
      takeOutput,
      onOutput: (output) => seen.push(...output.lines),
      intervalMs: 10
    });
    return { watch, seen, takeOutput };
  };

  it("collects what is said, in the order it was said", async () => {
    const { watch, seen } = setup([["opening input"], ["encoding"], ["done"]]);

    watch.start();
    await vi.advanceTimersByTimeAsync(25);
    await watch.stop();

    expect(seen).toEqual(["opening input", "encoding", "done"]);
  });

  /**
   * A silent look is still news: it is how the window learns that ffmpeg has
   * finished and the packaging that follows it has begun. The window is opened
   * by the caller, so reporting quiet cannot open one for a recording that
   * needs no work.
   */
  it("reports a look that found nothing", async () => {
    const onOutput = vi.fn();
    const finished: ConversionOutput = {
      lines: [],
      durationSecs: 600,
      positionSecs: 600,
      running: false
    };
    const watch = createConversionWatch({
      takeOutput: async () => finished,
      onOutput,
      intervalMs: 10
    });

    watch.start();
    await vi.advanceTimersByTimeAsync(30);
    await watch.stop();

    expect(onOutput).toHaveBeenCalledWith(finished);
  });

  /**
   * ffmpeg goes quiet once it is encoding — the words are all in the header —
   * so after the first second the only thing still moving is the position.
   * Reporting only batches with words in them would freeze the bar there.
   */
  it("reports a position even when nothing was said", async () => {
    const onOutput = vi.fn();
    const watch = createConversionWatch({
      takeOutput: async () => ({ lines: [], durationSecs: 600, positionSecs: 42, running: true }),
      onOutput,
      intervalMs: 10
    });

    watch.start();
    await vi.advanceTimersByTimeAsync(10);
    await watch.stop();

    expect(onOutput).toHaveBeenCalledWith({
      lines: [],
      durationSecs: 600,
      positionSecs: 42,
      running: true
    });
  });

  /**
   * The lines that explain a failure are printed immediately before ffmpeg
   * exits — which is exactly when the caller stops watching.
   */
  it("takes one last look as it stops", async () => {
    const { watch, seen } = setup([[], ["Conversion failed!"]]);

    watch.start();
    await watch.stop();

    expect(seen).toEqual(["Conversion failed!"]);
  });

  it("stops polling once stopped", async () => {
    const { watch, takeOutput } = setup([]);

    watch.start();
    await vi.advanceTimersByTimeAsync(20);
    await watch.stop();
    const callsAtStop = takeOutput.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);

    expect(takeOutput.mock.calls.length).toBe(callsAtStop);
  });

  it("keeps watching when one look fails", async () => {
    const onOutput = vi.fn();
    let call = 0;
    const watch = createConversionWatch({
      takeOutput: async () => {
        call += 1;
        if (call === 1) {
          throw new Error("busy");
        }
        return said("still going");
      },
      onOutput,
      intervalMs: 10
    });

    watch.start();
    await vi.advanceTimersByTimeAsync(25);
    await watch.stop();

    expect(onOutput).toHaveBeenCalledWith(said("still going"));
  });

  /**
   * The caller closes the window the moment `stop` returns. A look still in
   * flight then would answer into a conversion that is over, reopening the
   * window with nothing behind it and nothing left to close it.
   */
  it("does not deliver a look that was in flight when it stopped", async () => {
    const seen: string[] = [];
    let release: (output: ConversionOutput) => void = () => {};
    let call = 0;
    const watch = createConversionWatch({
      takeOutput: () => {
        call += 1;
        if (call === 1) {
          return new Promise<ConversionOutput>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(said());
      },
      onOutput: (output) => seen.push(...output.lines),
      intervalMs: 10
    });

    watch.start();
    await watch.stop();
    release(said("late line"));
    await vi.advanceTimersByTimeAsync(50);

    expect(seen).toEqual([]);
  });

  it("does not start twice", async () => {
    const { watch, takeOutput } = setup([]);

    watch.start();
    watch.start();
    await vi.advanceTimersByTimeAsync(10);
    await watch.stop();

    // Two pollers would double the looks taken in the same span.
    expect(takeOutput.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("a look that fails", () => {
  /**
   * `running: false` is not "unknown" — it is "the conversion has ended", and
   * the window changes what it says and what its bar measures on it. One
   * dropped call mid-conversion used to move it on to the packaging step.
   */
  it("does not report the conversion as finished", async () => {
    const seen: boolean[] = [];
    let call = 0;
    const watch = createConversionWatch({
      intervalMs: 1,
      takeOutput: async () => {
        call += 1;
        if (call === 2) {
          throw new Error("the conversion could not be reached");
        }
        return { lines: [], durationSecs: null, positionSecs: null, running: true };
      },
      onOutput: (output) => seen.push(output.running)
    });

    watch.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await watch.stop();

    expect(seen.length).toBeGreaterThan(2);
    expect(seen.slice(0, 3), "a failed look said the conversion had ended").toEqual([true, true, true]);
  });

  it("starts each conversion knowing nothing about the last", async () => {
    const seen: boolean[] = [];
    let reachable = true;
    const watch = createConversionWatch({
      intervalMs: 1,
      takeOutput: async () => {
        if (!reachable) {
          throw new Error("unreachable");
        }
        return { lines: [], durationSecs: null, positionSecs: null, running: true };
      },
      onOutput: (output) => seen.push(output.running)
    });

    watch.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await watch.stop();

    reachable = false;
    seen.length = 0;
    watch.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await watch.stop();

    expect(seen.every((running) => running === false)).toBe(true);
  });
});
