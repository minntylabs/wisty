/**
 * Playing a passage of the open recording.
 *
 * Rust holds the device, the recording and the decode (src-tauri/src/playback.rs)
 * and receives absolute seconds. Everything in this file is the policy that
 * decision leaves on this side: how much to pad a span, and when playback has
 * to stop.
 *
 * It deliberately knows nothing about markers, CodeMirror or the editor. A
 * marker click is one caller; a scrub bar or play-from-cursor would be another,
 * and neither should have to go through the marker extension to reach audio.
 */

export type PlaybackPort = {
  playSpan: (start: number, end: number) => Promise<void>;
  stopPlayback: () => Promise<void>;
  releasePlayback: () => Promise<void>;
};

/**
 * Padding, in seconds, added to every span before it is played.
 *
 * Whisper's word timings are accurate to about ±150 ms, and a snippet clipped
 * at either end is hard to judge — which defeats the point, since the feature
 * exists to settle what a word was.
 *
 * Both figures were calibrated by ear against the recordings this was built
 * for (§3.5 of the plan). The tail is the one that matters and the one the
 * plan originally missed: word *end* times run short, so playing to a stored
 * end time cuts off partway through the final word. 0.1s and 0.2s still
 * clipped; 0.3s was clean; 0.35s passed on all four test sentences.
 *
 * These are applied here rather than baked into the stored times, which stay
 * the truth of what was said. A pad may run a little into the next sentence's
 * first syllable — much the lesser evil against losing the last word, and
 * clamping against the next marker would reintroduce the neighbour lookup that
 * self-describing markers exist to avoid.
 */
export const HEAD_PAD_SECONDS = 0.25;
export const TAIL_PAD_SECONDS = 0.35;

/**
 * The span actually played for a marker's stored times.
 *
 * Clamped at zero because the first sentence of a recording starts near it and
 * a negative start is not a time. No clamp at the end: the recording's length
 * is not known here, and Rust already returns what exists rather than failing
 * when a span runs past the end.
 */
export const paddedSpan = (start: number, end: number): { start: number; end: number } => ({
  start: Math.max(0, start - HEAD_PAD_SECONDS),
  end: end + TAIL_PAD_SECONDS
});

export type PlaybackService = {
  /** Plays a marker's span, padded. Any span already playing is replaced. */
  playMarker: (start: number, end: number) => void;
  stop: () => Promise<void>;
  /** Drops the device and the recording. For document close and app quit. */
  release: () => Promise<void>;
};

/**
 * `onError` exists because playback is fire-and-forget from a click handler:
 * nothing awaits these, so a rejected promise would otherwise be an unhandled
 * rejection in the console and silence for the user.
 *
 * Note what is NOT here: any notion of which document a play belongs to.
 * `play_span` is async and `release_playback` is not, so they do not run in the
 * order they were sent, and a play can arrive after the document it came from
 * was closed. That is guarded on the Rust side, which arms on open and disarms
 * on release. It was briefly guarded here instead, by a counter this module
 * incremented — and that was worse than the bug it fixed, because this module
 * is rebuilt on a webview reload and its counter restarted while Rust's did
 * not, silently killing playback for the life of the process.
 */
export const createPlaybackService = (
  port: PlaybackPort,
  onError: (error: unknown) => void
): PlaybackService => {
  const run = (action: () => Promise<void>) => {
    void action().catch(onError);
  };

  return {
    playMarker: (start, end) => {
      // A marker whose times cannot be played is a damaged document rather than
      // a playback problem, and asking Rust to play it would only produce a
      // dialog saying so. Ignoring it leaves the rest of the transcript usable.
      //
      // Backwards only, not zero-length. An instantaneous cue is ordinary —
      // Whisper emits a few per recording — and the parser keeps them precisely
      // because the padding around a span makes them audible anyway. Refusing
      // them here made those sentences silently unclickable.
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return;
      }
      const span = paddedSpan(start, end);
      run(() => port.playSpan(span.start, span.end));
    },
    stop: async () => {
      await port.stopPlayback().catch(onError);
    },
    release: async () => {
      // Deliberately not routed to onError. This runs while a document is
      // closing, which the user did not ask for audio during: a missing output
      // device must not raise a dialog blaming playback for a close. Nothing
      // downstream can act on it either, since the document is going anyway.
      await port.releasePlayback().catch(() => {});
    }
  };
};
