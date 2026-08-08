/**
 * The Tauri side of playback, kept apart from the policy in playbackService so
 * that policy is testable without a bridge. Matches the pattern fileService
 * already uses for the container commands.
 */

import { invoke } from "@tauri-apps/api/core";
import type { PlaybackPort } from "./playbackService";

export const tauriPlaybackPort: PlaybackPort = {
  /** Absolute seconds into the recording, padding already applied. */
  playSpan: (start, end, session) => invoke("play_span", { start, end, session }),
  stopPlayback: () => invoke("stop_playback"),
  releasePlayback: (session) => invoke("release_playback", { session })
};
