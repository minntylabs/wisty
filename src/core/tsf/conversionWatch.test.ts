import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversionWatch } from "./conversionWatch";

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
    const takeOutput = vi.fn(async () => batches[call++] ?? []);
    const watch = createConversionWatch({
      takeOutput,
      onOutput: (lines) => seen.push(...lines),
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

  it("says nothing when there is nothing to say", async () => {
    const onOutput = vi.fn();
    const watch = createConversionWatch({
      takeOutput: async () => [],
      onOutput,
      intervalMs: 10
    });

    watch.start();
    await vi.advanceTimersByTimeAsync(30);
    await watch.stop();

    expect(onOutput).not.toHaveBeenCalled();
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
        return ["still going"];
      },
      onOutput,
      intervalMs: 10
    });

    watch.start();
    await vi.advanceTimersByTimeAsync(25);
    await watch.stop();

    expect(onOutput).toHaveBeenCalledWith(["still going"]);
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
