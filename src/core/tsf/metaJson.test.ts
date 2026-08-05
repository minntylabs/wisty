import { describe, expect, it } from "vitest";
import { createMetaDraft, TSF_VERSION } from "./metaJson";

const generator = { tool: "wisty", version: "2.5.0" };

describe("createMetaDraft", () => {
  it("stamps the format version", () => {
    const draft = createMetaDraft({
      audioFile: "audio.m4a",
      recording: "mum_11_2026-07.m4a",
      generator
    });
    expect(draft.tsf_version).toBe(TSF_VERSION);
  });

  it("names the audio member and the source recording", () => {
    const draft = createMetaDraft({
      audioFile: "audio.m4a",
      recording: "mum_11_2026-07.m4a",
      generator
    });
    expect(draft.audio.file).toBe("audio.m4a");
    expect(draft.source.recording).toBe("mum_11_2026-07.m4a");
  });

  it("omits the recording date rather than writing an empty one", () => {
    const draft = createMetaDraft({
      audioFile: "audio.m4a",
      recording: "r.m4a",
      generator
    });
    expect("recorded" in draft.source).toBe(false);
  });

  it("keeps the recording date when it is known", () => {
    const draft = createMetaDraft({
      audioFile: "audio.m4a",
      recording: "r.m4a",
      recorded: "2026-07-14",
      generator
    });
    expect(draft.source.recorded).toBe("2026-07-14");
  });

  it("carries generator provenance through verbatim", () => {
    const draft = createMetaDraft({
      audioFile: "audio.m4a",
      recording: "r.m4a",
      generator: {
        tool: "wisty",
        version: "2.5.0",
        asr_model: "faster-whisper-large-v3",
        diarization_model: "pyannote-community-1",
        generated: "2026-08-05T14:22:00Z"
      }
    });
    expect(draft.generator).toEqual({
      tool: "wisty",
      version: "2.5.0",
      asr_model: "faster-whisper-large-v3",
      diarization_model: "pyannote-community-1",
      generated: "2026-08-05T14:22:00Z"
    });
  });

  it("does not fill duration or codec, which the Rust side reads from the audio", () => {
    const draft = createMetaDraft({
      audioFile: "audio.m4a",
      recording: "r.m4a",
      generator
    });
    expect("duration" in draft.audio).toBe(false);
    expect("codec" in draft.audio).toBe(false);
  });

  it("survives a JSON round trip, which is how it crosses the bridge", () => {
    const draft = createMetaDraft({
      audioFile: "audio.m4a",
      recording: "r.m4a",
      recorded: "2026-07-14",
      generator
    });
    expect(JSON.parse(JSON.stringify(draft))).toEqual(draft);
  });
});
