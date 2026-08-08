/**
 * Building a transcript container from a timed transcript and a recording.
 *
 * This is step 11 of the plan, and the last of it: the machinery under here —
 * the subtitle parser, the transcript builder, the container writer in Rust —
 * was built early and wired to nothing, so containers have until now come from
 * a throwaway script.
 *
 * The order of the questions is the order of what can go wrong. The transcript
 * is read and parsed before the recording is asked for, so a file that turns
 * out not to be a transcript at all costs one dialog rather than three. The
 * recording is probed before anything is written, so a transcript paired with
 * the wrong recording — the likeliest real mistake — is caught while it is
 * still two files rather than after it has become a container.
 *
 * Everything it touches is injected, so the whole flow is exercised in tests
 * without a dialog, a filesystem or Rust.
 */

import { parseSubtitles, validateCues, type Cue, type CueProblem } from "./vtt";
import { buildTranscript } from "./transcriptBuilder";
import { createMetaDraft } from "./metaJson";

export type ImportTranscriptDeps = {
  dialogs: {
    /** The .vtt or .srt. */
    pickSubtitles: () => Promise<{ kind: "cancelled" } | { kind: "opened"; filePath: string }>;
    /** The recording it describes. */
    pickAudio: (defaultPath?: string) => Promise<{ kind: "cancelled" } | { kind: "opened"; filePath: string }>;
    /** Where the container goes. */
    pickContainerPath: (defaultPath?: string) => Promise<{ kind: "cancelled" } | { kind: "saved"; filePath: string }>;
  };
  readTextFile: (filePath: string) => Promise<string>;
  probeAudio: (filePath: string) => Promise<{ duration: number; codec: string }>;
  createContainer: (params: {
    outputPath: string;
    transcript: string;
    audioPath: string;
    meta: Record<string, unknown>;
  }) => Promise<{ path: string }>;
  /**
   * Asked when the cues do not sit comfortably against the recording. Answering
   * no abandons the import; none of these problems prevents a usable container,
   * so none of them refuses on its own.
   */
  confirmProblems: (problems: CueProblem[], cueCount: number) => Promise<boolean>;
  /** For meta.json's provenance, which no code reads and readers may need. */
  appVersion: () => string;
  now?: () => Date;
};

export type ImportTranscriptResult =
  | { kind: "cancelled" }
  | { kind: "created"; filePath: string; cues: number; problems: CueProblem[] };

const fileName = (filePath: string) => filePath.slice(filePath.lastIndexOf("/") + 1);

const withoutExtension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

const directory = (filePath: string) => {
  const slash = filePath.lastIndexOf("/");
  if (slash < 0) {
    return "";
  }
  return slash === 0 ? "/" : filePath.slice(0, slash);
};

/** The cue count, for a caller that wants to say what it built. */
const countCues = (cues: readonly Cue[]) => cues.length;

export const importTranscript = async (
  deps: ImportTranscriptDeps
): Promise<ImportTranscriptResult> => {
  const subtitles = await deps.dialogs.pickSubtitles();
  if (subtitles.kind === "cancelled") {
    return { kind: "cancelled" };
  }

  // Parsed before the recording is asked for: a file that is not a transcript
  // should cost one dialog, not three. Throws SubtitleParseError, which the
  // caller reports — it already names what is wrong with the file.
  const cues = parseSubtitles(await deps.readTextFile(subtitles.filePath));

  const audio = await deps.dialogs.pickAudio(directory(subtitles.filePath));
  if (audio.kind === "cancelled") {
    return { kind: "cancelled" };
  }

  // Before anything is written, so that a transcript and a recording that do
  // not belong together are still two files when it is noticed.
  const facts = await deps.probeAudio(audio.filePath);
  const problems = validateCues(cues, facts.duration);
  if (problems.length > 0 && !await deps.confirmProblems(problems, countCues(cues))) {
    return { kind: "cancelled" };
  }

  const suggested = `${directory(audio.filePath)}/${withoutExtension(fileName(audio.filePath))}.tsf`;
  const output = await deps.dialogs.pickContainerPath(suggested);
  if (output.kind === "cancelled") {
    return { kind: "cancelled" };
  }

  const meta = createMetaDraft({
    audioFile: fileName(audio.filePath),
    recording: fileName(audio.filePath),
    generator: {
      tool: `wisty ${deps.appVersion()}`,
      generated: (deps.now?.() ?? new Date()).toISOString()
    }
  });

  const created = await deps.createContainer({
    outputPath: output.filePath,
    transcript: buildTranscript(cues),
    audioPath: audio.filePath,
    // Rust fills in the audio's duration and codec from the file it is
    // copying, so what is sent is a draft and not the whole of meta.json.
    meta: meta as unknown as Record<string, unknown>
  });

  return { kind: "created", filePath: created.path, cues: countCues(cues), problems };
};
