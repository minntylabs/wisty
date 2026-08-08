/**
 * Runs an async task, coalescing anything asked for while it is running into a
 * single further run.
 *
 * A plain "already running, ignore this" flag drops the request instead of
 * deferring it, and the dropped one can be the one that mattered: a check
 * started as the window loses focus is still in flight when the window is
 * focused again, so the trigger that would have noticed the file changing in
 * between is discarded and nothing looks again until the next time.
 *
 * Any number of requests during one run collapse into one more run, since they
 * all ask the same question and only the answer after the last of them counts.
 */
export const createCoalescingTrigger = (run: () => Promise<unknown>) => {
  let running = false;
  let requestedAgain = false;

  const trigger = () => {
    if (running) {
      requestedAgain = true;
      return;
    }
    running = true;
    void run().catch(() => {
      // The task owns its failures; this only decides when it runs.
    }).finally(() => {
      running = false;
      if (requestedAgain) {
        requestedAgain = false;
        trigger();
      }
    });
  };

  return trigger;
};
