/**
 * What ffmpeg's header says, in the few lines a person actually wants.
 *
 * ffmpeg's output is written for ffmpeg: build flags, library versions, stream
 * maps and muxing overhead. Three facts in there answer the only questions the
 * window is asked — which recording is this, what is it now, and what is it
 * becoming — so those are lifted out and the rest is kept behind a disclosure
 * for when something goes wrong.
 *
 * Every field is optional on purpose. This reads output whose exact wording is
 * ffmpeg's business and varies by version, so a line that cannot be parsed
 * leaves a gap rather than inventing a fact or losing the window.
 */

export type ConversionSummary = {
  /** The recording's file name, as ffmpeg opened it. */
  source: string | null;
  /** What it is now: codec, rate, channels. */
  from: string | null;
  /** What it is becoming, with the bitrate it is being written at. */
  to: string | null;
};

/** `48000 Hz` reads as `48 kHz`, and nothing else is touched. */
const readable = (descriptor: string): string =>
  descriptor
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0)
    // The sample format is ffmpeg's internal business, not a fact about the
    // recording: nobody importing a transcript needs to know it is planar.
    .filter((field) => !/^(fltp|flt|s16p?|s32p?|u8p?|dblp?)$/.test(field))
    .map((field) => {
      const hertz = /^(\d+) Hz$/.exec(field);
      if (!hertz) {
        return field;
      }
      const kilohertz = Number(hertz[1]) / 1000;
      return `${Number(kilohertz.toFixed(1))} kHz`;
    })
    .join(", ");

/** Drops ffmpeg's codec tags — `(mp4a / 0x6134706D)` — and keeps `aac (LC)`. */
const withoutTags = (descriptor: string): string =>
  descriptor.replace(/\s*\([^)]*(?:\/|0x)[^)]*\)/g, "");

const quotedPath = (line: string): string | null => {
  const match = /'(.+)'/.exec(line);
  if (!match) {
    return null;
  }
  const path = match[1];
  const separator = path.lastIndexOf("/");
  return separator === -1 ? path : path.slice(separator + 1);
};

const audioDescriptor = (line: string): string | null => {
  const match = /Audio:\s*(.+)$/.exec(line);
  return match ? readable(withoutTags(match[1])) : null;
};

export const summariseConversion = (lines: string[]): ConversionSummary => {
  const summary: ConversionSummary = { source: null, from: null, to: null };
  // Which block the stream lines that follow belong to. The lines themselves
  // are identical in shape either side of it.
  let side: "input" | "output" | null = null;

  for (const line of lines) {
    if (/^Input #/.test(line)) {
      side = "input";
      summary.source = summary.source ?? quotedPath(line);
      continue;
    }
    if (/^Output #/.test(line)) {
      side = "output";
      continue;
    }
    if (!/Stream #.*Audio:/.test(line)) {
      continue;
    }
    const descriptor = audioDescriptor(line);
    if (!descriptor) {
      continue;
    }
    // The first audio stream on each side. A recording with several is one
    // ffmpeg is picking from, and the window is not the place to argue.
    if (side === "input") {
      summary.from = summary.from ?? descriptor;
    } else if (side === "output") {
      summary.to = summary.to ?? descriptor;
    }
  }

  return summary;
};

/** `m:ss`, or `h:mm:ss` past the hour, for a position or a length. */
export const formatDuration = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60) % 60;
  const hours = Math.floor(whole / 3600);
  const paddedSeconds = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
};
