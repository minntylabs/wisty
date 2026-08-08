import { describe, expect, it, vi } from "vitest";
import { importTranscript, type ImportTranscriptDeps } from "./importTranscript";
import { SubtitleParseError, type CueProblem } from "./vtt";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
<v ALICE>So we walked down.

00:00:03.000 --> 00:00:05.000
<v BOB>And then it rained.
`;

const createDeps = (overrides: Partial<ImportTranscriptDeps> = {}) => {
  const createContainer = vi.fn(async (params: {
    outputPath: string;
    transcript: string;
    audioPath: string;
    meta: Record<string, unknown>;
  }) => ({ path: params.outputPath }));
  const confirmProblems = vi.fn(async (_problems: CueProblem[], _cueCount: number) => true);
  const probeAudio = vi.fn(async () => ({ duration: 60, codec: "aac" }));
  const pickAudio = vi.fn(async () => ({ kind: "opened" as const, filePath: "/recordings/mum_11.m4a" }));
  const pickContainerPath = vi.fn(async () => ({ kind: "saved" as const, filePath: "/out/mum_11.tsf" }));

  const deps: ImportTranscriptDeps = {
    dialogs: {
      pickSubtitles: async () => ({ kind: "opened", filePath: "/transcripts/mum_11.vtt" }),
      pickAudio,
      pickContainerPath
    },
    readTextFile: async () => VTT,
    probeAudio,
    createContainer,
    confirmProblems,
    appVersion: () => "2.5.0",
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    ...overrides
  };

  return { deps, createContainer, confirmProblems, probeAudio, pickAudio, pickContainerPath };
};

describe("importing a transcript", () => {
  it("builds a container from the transcript and the recording", async () => {
    const { deps, createContainer } = createDeps();

    const result = await importTranscript(deps);

    expect(result).toMatchObject({ kind: "created", filePath: "/out/mum_11.tsf", cues: 2 });
    const [params] = createContainer.mock.calls[0];
    expect(params).toMatchObject({
      outputPath: "/out/mum_11.tsf",
      audioPath: "/recordings/mum_11.m4a"
    });
  });

  it("writes the cues as markers, with their speakers", async () => {
    const { deps, createContainer } = createDeps();

    await importTranscript(deps);

    const [params] = createContainer.mock.calls[0];
    expect(params.transcript).toContain("ALICE:");
    expect(params.transcript).toContain("⟦1.00–3.00⟧");
    expect(params.transcript).toContain("So we walked down.");
  });

  it("names the recording in the metadata it sends", async () => {
    const { deps, createContainer } = createDeps();

    await importTranscript(deps);

    const [params] = createContainer.mock.calls[0];
    expect(params.meta).toMatchObject({
      tsf_version: 1,
      audio: { file: "mum_11.m4a" },
      source: { recording: "mum_11.m4a" }
    });
  });

  /**
   * The order of the questions is the order of what can go wrong: a file that
   * is not a transcript should cost one dialog rather than three.
   */
  it("gives up on an unreadable transcript before asking for the recording", async () => {
    const { deps, pickAudio } = createDeps({ readTextFile: async () => "not a transcript at all" });

    await expect(importTranscript(deps)).rejects.toBeInstanceOf(SubtitleParseError);
    expect(pickAudio).not.toHaveBeenCalled();
  });

  it("suggests a container beside the recording, named after it", async () => {
    const { deps, pickContainerPath } = createDeps();

    await importTranscript(deps);

    expect(pickContainerPath).toHaveBeenCalledWith("/recordings/mum_11.tsf");
  });

  describe("when the cues do not fit the recording", () => {
    /** The likeliest real mistake: this transcript, that recording. */
    const shortRecording = { probeAudio: vi.fn(async () => ({ duration: 2, codec: "aac" })) };

    it("asks before writing anything", async () => {
      const { deps, confirmProblems, createContainer } = createDeps(shortRecording);

      await importTranscript(deps);

      expect(confirmProblems).toHaveBeenCalled();
      const [problems] = confirmProblems.mock.calls[0];
      expect(problems.some((problem) => problem.kind === "beyond-audio")).toBe(true);
      expect(createContainer).toHaveBeenCalled();
    });

    it("writes nothing when the answer is no", async () => {
      const { deps, createContainer, pickContainerPath } = createDeps({
        ...shortRecording,
        confirmProblems: async () => false
      });

      await expect(importTranscript(deps)).resolves.toEqual({ kind: "cancelled" });
      expect(pickContainerPath).not.toHaveBeenCalled();
      expect(createContainer).not.toHaveBeenCalled();
    });
  });

  describe("cancelling", () => {
    it("at the transcript asks nothing else", async () => {
      const { deps, probeAudio, createContainer } = createDeps({
        dialogs: {
          pickSubtitles: async () => ({ kind: "cancelled" }),
          pickAudio: vi.fn(),
          pickContainerPath: vi.fn()
        }
      });

      await expect(importTranscript(deps)).resolves.toEqual({ kind: "cancelled" });
      expect(probeAudio).not.toHaveBeenCalled();
      expect(createContainer).not.toHaveBeenCalled();
    });

    it("at the recording writes nothing", async () => {
      const { deps, createContainer } = createDeps({
        dialogs: {
          pickSubtitles: async () => ({ kind: "opened", filePath: "/transcripts/mum_11.vtt" }),
          pickAudio: async () => ({ kind: "cancelled" }),
          pickContainerPath: vi.fn()
        }
      });

      await expect(importTranscript(deps)).resolves.toEqual({ kind: "cancelled" });
      expect(createContainer).not.toHaveBeenCalled();
    });

    it("at the destination writes nothing", async () => {
      const { deps, createContainer } = createDeps({
        dialogs: {
          pickSubtitles: async () => ({ kind: "opened", filePath: "/transcripts/mum_11.vtt" }),
          pickAudio: async () => ({ kind: "opened", filePath: "/recordings/mum_11.m4a" }),
          pickContainerPath: async () => ({ kind: "cancelled" })
        }
      });

      await expect(importTranscript(deps)).resolves.toEqual({ kind: "cancelled" });
      expect(createContainer).not.toHaveBeenCalled();
    });
  });
});
