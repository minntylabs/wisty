import { describe, it, expect } from "vitest";
import { useErrorModalQueue } from "./useErrorModalQueue";

const failure = (message: string, title = "Unable to save file") => ({ title, message });

describe("the error queue", () => {
  it("shows the first report and holds the rest behind it", () => {
    const queue = useErrorModalQueue();
    queue.enqueue(failure("the disk is full"));
    queue.enqueue(failure("the file has gone"));

    expect(queue.open()).toBe(true);
    expect(queue.current()?.message).toBe("the disk is full");

    queue.dismissCurrent();
    expect(queue.current()?.message).toBe("the file has gone");

    queue.dismissCurrent();
    expect(queue.open()).toBe(false);
  });

  /**
   * Every one of these is dismissed by hand. A save retried on a timer against
   * a disconnected drive used to enqueue one dialog per attempt, leaving a
   * stack of identical dialogs to click through.
   */
  it("does not queue the same failure twice", () => {
    const queue = useErrorModalQueue();
    queue.enqueue(failure("the drive is not there"));
    queue.enqueue(failure("the drive is not there"));
    queue.enqueue(failure("the drive is not there"));

    expect(queue.entries()).toHaveLength(1);
  });

  it("counts a report as the same one even while it is on screen", () => {
    // The one showing is the one being read; repeating it behind itself is the
    // case that actually happens.
    const queue = useErrorModalQueue();
    queue.enqueue(failure("the drive is not there"));
    expect(queue.current()?.message).toBe("the drive is not there");
    queue.enqueue(failure("the drive is not there"));

    queue.dismissCurrent();
    expect(queue.open()).toBe(false);
  });

  it("tells apart reports that differ in title or code", () => {
    const queue = useErrorModalQueue();
    queue.enqueue(failure("the drive is not there"));
    queue.enqueue(failure("the drive is not there", "Unable to open file"));
    queue.enqueue({ ...failure("the drive is not there"), code: "EIO" });

    expect(queue.entries()).toHaveLength(3);
  });

  it("stops collecting once enough are waiting", () => {
    const queue = useErrorModalQueue();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      queue.enqueue(failure(`failure number ${attempt}`));
    }

    expect(queue.entries().length).toBeLessThanOrEqual(5);
    // The earliest are kept: the first failure is usually the cause and the
    // ones after it the consequences.
    expect(queue.current()?.message).toBe("failure number 0");
  });

  it("takes new reports again once the queue has been read", () => {
    const queue = useErrorModalQueue();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      queue.enqueue(failure(`failure number ${attempt}`));
    }
    const held = queue.entries().length;
    queue.dismissCurrent();

    queue.enqueue(failure("something new"));
    const waiting = queue.entries();
    expect(waiting).toHaveLength(held);
    expect(waiting[waiting.length - 1]?.message).toBe("something new");
  });

  it("clears everything at once", () => {
    const queue = useErrorModalQueue();
    queue.enqueue(failure("one"));
    queue.enqueue(failure("two"));
    queue.clear();
    expect(queue.open()).toBe(false);
  });
});
