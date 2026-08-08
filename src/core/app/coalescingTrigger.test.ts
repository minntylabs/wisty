import { describe, expect, it } from "vitest";
import { createCoalescingTrigger } from "./coalescingTrigger";

/** A task the test finishes by hand, so nothing here depends on timing. */
const deferredTask = () => {
  const finishers: (() => void)[] = [];
  let started = 0;
  const run = () => {
    started += 1;
    return new Promise<void>((resolve) => finishers.push(resolve));
  };
  return {
    run,
    starts: () => started,
    /** Finishes the run in flight and lets anything queued behind it begin. */
    finish: async () => {
      finishers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
};

describe("coalescing trigger", () => {
  it("runs straight away when nothing is in flight", () => {
    const task = deferredTask();
    createCoalescingTrigger(task.run)();
    expect(task.starts()).toBe(1);
  });

  it("runs again for a request made while it was running", async () => {
    const task = deferredTask();
    const trigger = createCoalescingTrigger(task.run);

    trigger();
    // The window regained focus while the first run was still in flight. This
    // is the request a plain in-flight flag would have thrown away.
    trigger();
    expect(task.starts()).toBe(1);

    await task.finish();
    expect(task.starts()).toBe(2);
  });

  it("collapses several requests during one run into one more", async () => {
    const task = deferredTask();
    const trigger = createCoalescingTrigger(task.run);

    trigger();
    trigger();
    trigger();
    trigger();
    await task.finish();
    expect(task.starts()).toBe(2);

    // And that second run leaves nothing else queued behind it.
    await task.finish();
    expect(task.starts()).toBe(2);
  });

  it("keeps running after a task fails", async () => {
    let started = 0;
    const trigger = createCoalescingTrigger(async () => {
      started += 1;
      throw new Error("stat failed");
    });

    trigger();
    await Promise.resolve();
    await Promise.resolve();
    trigger();
    await Promise.resolve();

    expect(started).toBe(2);
  });
});
