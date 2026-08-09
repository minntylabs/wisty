import { describe, expect, it } from "vitest";
import { formatDuration, summariseConversion } from "./conversionSummary";

/** ffmpeg 6.1's header for an opus recording on its way to AAC-LC, verbatim. */
const REAL_OUTPUT = [
  "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers",
  "  built with gcc 13 (Ubuntu 13.3.0-6ubuntu2~24.04.1)",
  "  configuration: --prefix=/usr --extra-version=3ubuntu5 --toolchain=hardened",
  "  libavutil      58. 29.100 / 58. 29.100",
  "Input #0, ogg, from '/home/dan/recordings/interview.opus':",
  "  Duration: 00:41:30.01, start: 0.000000, bitrate: 80 kb/s",
  "  Stream #0:0: Audio: opus, 48000 Hz, mono, fltp",
  "    Metadata:",
  "      encoder         : Lavc60.31.102 libopus",
  "Stream mapping:",
  "  Stream #0:0 -> #0:0 (opus (native) -> aac (native))",
  "Output #0, ipod, to '/tmp/wisty-import-1234-0.m4a':",
  "  Metadata:",
  "    encoder         : Lavf60.16.100",
  "  Stream #0:0: Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 64 kb/s"
];

describe("summarising a conversion", () => {
  it("lifts the three facts out of ffmpeg's header", () => {
    expect(summariseConversion(REAL_OUTPUT)).toEqual({
      source: "interview.opus",
      from: "opus, 48 kHz, mono",
      to: "aac (LC), 48 kHz, mono, 64 kb/s"
    });
  });

  /**
   * The input and output stream lines are identical in shape, so only the
   * block they follow tells them apart. Reading them by shape alone would
   * report the recording as already being what it is about to become.
   */
  it("tells the recording from what it is becoming", () => {
    const summary = summariseConversion(REAL_OUTPUT);
    expect(summary.from).not.toEqual(summary.to);
  });

  it("reports what it could not read as missing rather than guessing", () => {
    expect(summariseConversion(["Press [q] to stop"])).toEqual({
      source: null,
      from: null,
      to: null
    });
  });

  it("names the recording, not the path it was found at", () => {
    expect(summariseConversion(["Input #0, wav, from '/a/b/c/rec.wav':"]).source).toBe("rec.wav");
  });

  it("keeps a rate that is not a whole number of kilohertz", () => {
    const summary = summariseConversion(["Input #0, wav, from 'r.wav':", "  Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo, s16"]);
    expect(summary.from).toBe("pcm_s16le, 44.1 kHz, stereo");
  });
});

describe("formatting a length", () => {
  it("counts in minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(90)).toBe("1:30");
  });

  it("adds hours only once there are any", () => {
    expect(formatDuration(3599)).toBe("59:59");
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3661)).toBe("1:01:01");
  });
});
