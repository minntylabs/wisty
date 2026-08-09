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

/** What a running conversion has to report: its words, and its place. */
export type ConversionOutput = {
  /** ffmpeg's own lines since the last call, oldest first. */
  lines: string[];
  /** The recording's length, once ffmpeg has read it. */
  durationSecs: number | null;
  /** How far into the recording it has got. */
  positionSecs: number | null;
  /**
   * Whether ffmpeg is still running. Building a container is converting and
   * then packaging, and the window says different things about each.
   */
  running: boolean;
};

export type ConversionWatchDeps = {
  /** Whatever the conversion has said since the last call. */
  takeOutput: () => Promise<ConversionOutput>;
  /** Called with each batch, in the order it was said. */
  onOutput: (output: ConversionOutput) => void;
  intervalMs?: number;
};

const NOTHING: ConversionOutput = {
  lines: [],
  durationSecs: null,
  positionSecs: null,
  running: false
};

const DEFAULT_INTERVAL_MS = 150;

export const createConversionWatch = (deps: ConversionWatchDeps) => {
  const intervalMs = Math.max(1, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  /**
   * Which watch a look belongs to. A look already in flight when `stop` is
   * called answers after the caller has moved on — and its answer, delivered
   * then, would report a conversion that has finished as still running. The
   * window would reopen with nothing behind it and no way to close it.
   */
  let generation = 0;

  const poll = async (belongsTo: number) => {
    let output = NOTHING;
    try {
      output = await deps.takeOutput();
    } catch {
      // A conversion that cannot be asked what it is doing is still a
      // conversion. Losing its commentary is not worth ending it over.
    }
    if (belongsTo !== generation) {
      return;
    }
    // Every look is reported, including the empty ones. A silent conversion is
    // still news — it is how the window learns that ffmpeg has finished and
    // the packaging has started — and the window is opened by the caller now
    // rather than by the first thing said.
    deps.onOutput(output);
    if (running) {
      timer = setTimeout(() => void poll(belongsTo), intervalMs);
    }
  };

  return {
    start: () => {
      if (running) {
        return;
      }
      running = true;
      generation += 1;
      void poll(generation);
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
      // Disowns whatever is already in flight, and takes the last look under a
      // generation of its own so that look is still delivered.
      generation += 1;
      await poll(generation);
    }
  };
};
