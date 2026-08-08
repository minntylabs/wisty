import { describe, expect, it, vi } from "vitest";
import {
  HEAD_PAD_SECONDS,
  TAIL_PAD_SECONDS,
  createPlaybackService,
  paddedSpan,
  type PlaybackPort
} from "./playbackService";

const createHarness = () => {
  const port: PlaybackPort = {
    playSpan: vi.fn(async () => {}),
    stopPlayback: vi.fn(async () => {}),
    releasePlayback: vi.fn(async () => {})
  };
  const onError = vi.fn();
  return { port, onError, service: createPlaybackService(port, onError) };
};

describe("padding", () => {
  it("widens a span at both ends", () => {
    expect(paddedSpan(734.12, 736.8)).toEqual({
      start: 734.12 - HEAD_PAD_SECONDS,
      end: 736.8 + TAIL_PAD_SECONDS
    });
  });

  it("never asks for a negative start", () => {
    // The first sentence of a recording begins near zero, and a negative time
    // is not a position in a file.
    expect(paddedSpan(0.1, 2).start).toBe(0);
    expect(paddedSpan(0, 2).start).toBe(0);
  });

  it("does not clamp the end against the recording's length", () => {
    // The length is not known here, and the Rust side returns what exists
    // rather than failing. Clamping would need a duration this layer has no
    // business holding.
    expect(paddedSpan(1000, 1002).end).toBe(1002 + TAIL_PAD_SECONDS);
  });

  it("pads the tail more than the head", () => {
    // Not arbitrary: word end times run short, so the tail is the end that
    // clips. If these are ever equalised it should be a deliberate change.
    expect(TAIL_PAD_SECONDS).toBeGreaterThan(HEAD_PAD_SECONDS);
  });
});

describe("playing a marker", () => {
  it("sends the padded span, not the stored one", () => {
    const h = createHarness();
    h.service.playMarker(734.12, 736.8);
    expect(h.port.playSpan).toHaveBeenCalledWith(
      734.12 - HEAD_PAD_SECONDS,
      736.8 + TAIL_PAD_SECONDS,
      0
    );
  });

  it("ignores a marker whose times cannot be played", () => {
    // A damaged document rather than a playback fault. Asking Rust to play it
    // would only produce a dialog; ignoring leaves the rest usable.
    const h = createHarness();
    h.service.playMarker(Number.NaN, 5);
    h.service.playMarker(5, Number.POSITIVE_INFINITY);
    h.service.playMarker(5, 5);
    h.service.playMarker(6, 5);
    expect(h.port.playSpan).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("reports a failure rather than leaving it unhandled", async () => {
    // Nothing awaits a click, so without this a rejected promise is a console
    // warning and silence for the user — indistinguishable from a broken
    // feature when the real cause is something they could fix.
    const h = createHarness();
    const failure = new Error("no output device");
    (h.port.playSpan as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure);

    h.service.playMarker(1, 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.onError).toHaveBeenCalledWith(failure);
  });
});

describe("stopping and releasing", () => {
  it("passes both straight through", () => {
    const h = createHarness();
    h.service.stop();
    h.service.release();
    expect(h.port.stopPlayback).toHaveBeenCalled();
    expect(h.port.releasePlayback).toHaveBeenCalled();
  });

  it("says nothing when a release fails", async () => {
    // release() runs while a document is closing, which the user did not ask
    // for audio during. A missing output device must not raise a dialog
    // blaming playback for a close, and nothing downstream could act on it
    // anyway — the document is going regardless.
    const h = createHarness();
    (h.port.releasePlayback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    expect(() => h.service.release()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.onError).not.toHaveBeenCalled();
  });
});

/**
 * play_span is an async Tauri command and release_playback is not, so they do
 * not run in the order they were sent. Clicking a sentence and immediately
 * closing the document could start audio from a document already gone. The
 * stamp is what lets Rust drop such a play however the two are ordered.
 */
describe("session stamping", () => {
  const spanArgs = (port: PlaybackPort) =>
    (port.playSpan as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);

  it("stamps plays with the current session", () => {
    const h = createHarness();
    h.service.playMarker(1, 2);
    h.service.playMarker(3, 4);
    expect(spanArgs(h.port)).toEqual([0, 0]);
  });

  it("moves the session on when releasing, and tells Rust the new one", () => {
    const h = createHarness();
    h.service.release();
    expect(h.port.releasePlayback).toHaveBeenCalledWith(1);
  });

  it("stamps later plays with the later session", () => {
    // A play issued after the release belongs to whatever is open next and
    // must not be dropped along with the old document's.
    const h = createHarness();
    h.service.playMarker(1, 2);
    h.service.release();
    h.service.playMarker(3, 4);
    expect(spanArgs(h.port)).toEqual([0, 1]);
  });

  it("bumps the session before releasing, not after", () => {
    // The order matters: a play already queued behind the release has to be
    // superseded by the time it runs, which means the number Rust is told must
    // already be ahead of the stamp that play carries.
    const h = createHarness();
    h.service.playMarker(1, 2);
    h.service.release();
    const released = (h.port.releasePlayback as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(released).toBeGreaterThan(spanArgs(h.port)[0]);
  });
});
