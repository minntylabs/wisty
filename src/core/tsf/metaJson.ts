/**
 * meta.json — the contract carried inside every .tsf.
 *
 * Frozen before the first file was written, because every container ever
 * produced carries it.
 *
 * THE UNKNOWN-KEY RULE: readers must ignore keys they do not recognise. That,
 * rather than the shape of the schema, is what lets the format grow — a
 * producer can add fields freely and only a breaking change moves
 * `tsf_version`. Do not add a strict/exhaustive check to the parsing side.
 */

/** Bumped only for a breaking change. Additive fields do not move it. */
export const TSF_VERSION = 1;

export type TsfAudioMeta = {
  /** The audio member's filename inside the container. */
  file: string;
  /** Informational, for a human reading the extracted files. */
  codec: string;
  /**
   * Seconds. A sanity check, never a source of truth: the audio file is
   * authoritative and the player reads duration from the container itself. A
   * last marker beyond this means something is wrong.
   */
  duration: number;
};

export type TsfSourceMeta = {
  /** The original recording's filename, before it was copied in. */
  recording: string;
  /** ISO date of the recording, if known. */
  recorded?: string;
};

/**
 * Pure provenance — no code reads this. Deliberately generous: these
 * recordings will outlive the tooling, and "which model produced this
 * transcript" is unanswerable later otherwise.
 */
export type TsfGeneratorMeta = {
  tool: string;
  version?: string;
  asr_model?: string;
  diarization_model?: string;
  /** ISO 8601 timestamp. */
  generated?: string;
};

export type TsfMeta = {
  tsf_version: number;
  audio: TsfAudioMeta;
  source: TsfSourceMeta;
  generator: TsfGeneratorMeta;
  /** The word-timings member's filename, when one is present. */
  words?: string;
};

/**
 * The metadata the frontend can supply. `audio.duration` and `audio.codec` are
 * filled by the Rust side, which is already reading the audio to write it in,
 * so they are absent here.
 */
export type TsfMetaDraft = Omit<TsfMeta, "audio"> & { audio: Pick<TsfAudioMeta, "file"> };

export const createMetaDraft = (params: {
  audioFile: string;
  recording: string;
  recorded?: string;
  generator: TsfGeneratorMeta;
}): TsfMetaDraft => ({
  tsf_version: TSF_VERSION,
  audio: { file: params.audioFile },
  source: params.recorded
    ? { recording: params.recording, recorded: params.recorded }
    : { recording: params.recording },
  generator: params.generator
});
