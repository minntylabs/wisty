import type { CueProblem } from "./vtt";

/**
 * Cue problems, said in a way that points at the likely cause.
 *
 * None of these stops a container being built — a marker whose span is a little
 * wrong still plays roughly the right passage. They are worth showing because
 * of what they usually mean: cues running past the end of the recording are how
 * a transcript paired with the wrong recording announces itself, and that is
 * the mistake this import is most likely to make.
 */

const seconds = (value: number) => {
  const minutes = Math.floor(value / 60);
  const remainder = Math.floor(value % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
};

/** The line for one kind of problem, given how many cues have it. */
const describe = (problem: CueProblem, count: number): string => {
  const cues = count === 1 ? "1 cue" : `${count} cues`;
  switch (problem.kind) {
    case "beyond-audio":
      return `${cues} run past the end of the recording, which is ${seconds(problem.audioDuration)} long. `
        + "This usually means the transcript belongs to a different recording.";
    case "overlap":
      return `${cues} start before the one before them has ended.`;
    case "out-of-order":
      return `${cues} start earlier than the cue before them.`;
    case "backwards":
      return `${cues} end before they start.`;
  }
};

export const describeCueProblems = (problems: readonly CueProblem[]): string[] => {
  const byKind = new Map<CueProblem["kind"], { problem: CueProblem; count: number }>();
  for (const problem of problems) {
    const seen = byKind.get(problem.kind);
    if (seen) {
      seen.count += 1;
      continue;
    }
    byKind.set(problem.kind, { problem, count: 1 });
  }
  // Worst first: the one that means the wrong file was chosen leads.
  const order: CueProblem["kind"][] = ["beyond-audio", "backwards", "out-of-order", "overlap"];
  return order
    .map((kind) => byKind.get(kind))
    .filter((entry): entry is { problem: CueProblem; count: number } => entry !== undefined)
    .map((entry) => describe(entry.problem, entry.count));
};
