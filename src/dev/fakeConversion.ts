/**
 * A conversion that never finishes, for looking at the window while it runs.
 *
 * A real import gives about fifteen seconds of window, spent after three file
 * dialogs, which is no way to watch for something intermittent. This produces
 * the same shape of output on the same cadence and keeps going until it is
 * stopped, so the window can be held open for as long as it takes to see.
 *
 * Development only. Nothing imports this outside a `import.meta.env.DEV`
 * guard, so it is dropped from a production build entirely.
 */

import type { ConversionOutput } from "../core/tsf/conversionWatch";

/** ffmpeg's real header for an opus recording, so the summary fills in. */
const HEADER = [
  "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers",
  "  built with gcc 13 (Ubuntu 13.3.0-6ubuntu2~24.04.1)",
  "Input #0, ogg, from '/home/dan/probe/interview.opus':",
  "  Duration: 01:00:00.00, start: 0.000000, bitrate: 80 kb/s",
  "  Stream #0:0: Audio: opus, 48000 Hz, mono, fltp",
  "Stream mapping:",
  "  Stream #0:0 -> #0:0 (opus (native) -> aac (native))",
  "Output #0, ipod, to '/tmp/wisty-import-probe.m4a':",
  "  Stream #0:0: Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 64 kb/s"
];

const DURATION_SECS = 3600;
/** The real watch's interval, because the cadence is half the point. */
const TICK_MS = 150;

export type FakeConversion = { stop: () => void };

export const createFakeConversion = (deps: {
  onOutput: (output: ConversionOutput) => void;
  onFinished: () => void;
}): FakeConversion => {
  let position = 0;
  let tick = 0;

  deps.onOutput({ lines: HEADER, durationSecs: DURATION_SECS, positionSecs: 0 });

  const timer = setInterval(() => {
    tick += 1;
    // One line every second or so, as ffmpeg is once it is past its header:
    // mostly quiet, with the position moving underneath.
    position = Math.min(DURATION_SECS, position + 1.5);
    deps.onOutput({
      lines: tick % 7 === 0 ? [`[aac @ 0x5581f2a] probe line ${tick}`] : [],
      durationSecs: DURATION_SECS,
      positionSecs: position
    });
  }, TICK_MS);

  return {
    stop: () => {
      clearInterval(timer);
      deps.onFinished();
    }
  };
};
