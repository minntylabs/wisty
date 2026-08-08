/**
 * Collects what a running audio conversion is saying, while it runs.
 *
 * ffmpeg's own output is the progress report, and the window shows it verbatim:
 * inventing a summary would be more work and less true, and when a conversion
 * fails the thing that explains why is the last line ffmpeg printed.
 *
 * Polled rather than pushed. An event would arrive sooner, but it needs a
 * permission and a listener to unregister, and this runs for seconds inside one
 * operation that knows exactly when it starts and stops.
 */

export type ConversionWatchDeps = {
  /** Whatever the conversion has said since the last call. */
  takeOutput: () => Promise<string[]>;
  /** Called with each batch, in the order it was said. */
  onOutput: (lines: string[]) => void;
  intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 150;

export const createConversionWatch = (deps: ConversionWatchDeps) => {
  const intervalMs = Math.max(1, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const poll = async () => {
    let lines: string[] = [];
    try {
      lines = await deps.takeOutput();
    } catch {
      // A conversion that cannot be asked what it is doing is still a
      // conversion. Losing its commentary is not worth ending it over.
    }
    if (lines.length > 0) {
      deps.onOutput(lines);
    }
    if (running) {
      timer = setTimeout(() => void poll(), intervalMs);
    }
  };

  return {
    start: () => {
      if (running) {
        return;
      }
      running = true;
      void poll();
    },
    /**
     * Stops, after one last look: the lines explaining a failure are printed
     * immediately before ffmpeg exits, which is when the caller stops watching.
     */
    stop: async () => {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await poll();
    }
  };
};
