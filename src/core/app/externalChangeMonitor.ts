import { createSignal } from "solid-js";
import type {
  DocumentPort,
  ExpectedSaveSource,
  FileIoPort,
  TextFileVersion
} from "./contracts";
import { toAppError } from "../errors/appError";

/**
 * Whether the open document still matches the file on disk, and what to say
 * when it does not.
 *
 * This is a state machine with invariants that are easy to break from the
 * outside, which is why it is its own module. Two of them account for nearly
 * every fault this has had:
 *
 *  - Every wait is a window. Reading metadata takes long enough for another
 *    document to be opened, and what was learned about the old one must never
 *    land on the new one. Each baseline claims a generation, and anything that
 *    resolves after its generation has passed is discarded.
 *  - A conflict is raised *for* a version. Without recording which one, a
 *    dismissal has nothing to be a dismissal of, and the next check raises the
 *    same conflict over again.
 */

/**
 * How the file on disk disagrees with the document.
 *
 * `appeared` is the counterpart of `deleted` for a document being created: it
 * expected no file at its path, and something else put one there. `not-a-file`
 * is a directory, or anything else that is not a regular file, standing where
 * the document's file should be — which neither a reload nor an overwrite can
 * do anything with.
 */
export type ExternalChangeKind = "changed" | "deleted" | "appeared" | "not-a-file";

export type ExternalChange = {
  filePath: string;
  kind: ExternalChangeKind;
};

/**
 * What the document is measured against.
 *
 * `absent` is a baseline in its own right, not the lack of one: a document
 * created at an empty path asserts that the path is still empty when it saves.
 * Only `null` means nothing is known, and then a save asserts nothing.
 */
type TextFileBaseline =
  | { kind: "present"; version: TextFileVersion }
  | { kind: "absent" };

const sameTextFileVersion = (left: TextFileVersion, right: TextFileVersion) =>
  left.size === right.size
  && left.modifiedMs === right.modifiedMs
  && left.device === right.device
  && left.inode === right.inode;

/**
 * Which conflict, if any, the backend refused a save over.
 *
 * By code rather than by message: the wording lives in Rust, and matching it
 * from here would silently degrade every conflict into a generic save failure
 * the next time someone reworded it.
 */
export const externalChangeKindFromSaveError = (error: unknown): ExternalChangeKind | null => {
  switch (toAppError(error, "SAVE_FAILED", "Unable to save file").code) {
    case "SAVE_EXTERNAL_CHANGE":
      return "changed";
    case "SAVE_EXTERNAL_DELETE":
      return "deleted";
    case "SAVE_EXTERNAL_APPEARED":
      return "appeared";
    case "SAVE_EXTERNAL_NOT_A_FILE":
      return "not-a-file";
    default:
      return null;
  }
};

export type ExternalChangeMonitorDeps = {
  fileIo: Pick<FileIoPort, "getTextFilePresence">;
  document: Pick<DocumentPort, "state" | "markDirty">;
};

export const createExternalChangeMonitor = (deps: ExternalChangeMonitorDeps) => {
  const [change, setChange] = createSignal<ExternalChange | null>(null);
  const [dismissed, setDismissed] = createSignal(false);

  let baseline: TextFileBaseline | null = null;
  let generation = 0;
  let observedVersion: TextFileVersion | null = null;
  let baselineError: Error | null = null;

  /**
   * Whether the document a baseline was taken for is still the open one.
   *
   * The lifecycle keeps its own copy of this question for its own reasons — a
   * save marking the wrong document clean. Sharing one would tie two unrelated
   * concerns together for the sake of one line.
   */
  const documentIsAt = (filePath: string) =>
    deps.document.state.kind === "text" && deps.document.state.filePath === filePath;

  /**
   * Whether a baseline taken at `takenAt` is still the one in force.
   *
   * Every await between taking a baseline and acting on it is a window for
   * another document to be opened, and what was learned about the old one must
   * not land on the new one.
   */
  const isCurrent = (takenAt: number) => takenAt === generation;

  /**
   * Raises a conflict, recording the on-disk version it was raised for.
   *
   * That version is what a dismissal is a dismissal *of*: without it the next
   * check has nothing to recognise and raises the same conflict again.
   */
  const raise = (
    filePath: string,
    kind: ExternalChangeKind,
    observed: TextFileVersion | null = null
  ) => {
    observedVersion = observed;
    if (kind === "deleted" || kind === "not-a-file") {
      // The editor now holds the only copy of this text — there is nothing at
      // the path to go back to. Saying so keeps the close prompt in the way of
      // losing it, whether or not it was edited.
      deps.document.markDirty();
    }
    setChange({ filePath, kind });
    setDismissed(false);
  };

  /** Drops a conflict whose difference no longer exists. */
  const retract = () => {
    if (!change()) {
      return;
    }
    observedVersion = null;
    setChange(null);
    setDismissed(false);
  };

  /**
   * Forgets the baseline. `takenAt` scopes it to the baseline the caller took:
   * a load that fails after another document has replaced it has nothing left
   * to clear, and clearing anyway would leave the new document with no baseline
   * and its saves asserting nothing.
   */
  const clear = (takenAt?: number) => {
    if (takenAt !== undefined && !isCurrent(takenAt)) {
      return;
    }
    generation += 1;
    baseline = null;
    observedVersion = null;
    baselineError = null;
    setChange(null);
    setDismissed(false);
  };

  /**
   * Records what is on disk at `filePath` as what this document is measured
   * against.
   *
   * Never throws. A baseline is taken around operations that have already
   * succeeded, so a failure here says nothing about whether they did and must
   * not be reported as though it did. It is recorded instead, and Save is what
   * acts on it — the one operation the missing baseline would endanger.
   *
   * `missingIsExpected` separates the two reasons a path can hold no file: a
   * document being created there, and a file that has gone since Wisty last
   * looked. The second is a deletion the user has to be told about, and saying
   * nothing would let a save recreate it silently.
   *
   * Returns the generation it claimed, so a caller can tell whether what it
   * took is still in force by the time its own work is done.
   */
  const capture = async (
    filePath: string,
    options?: { missingIsExpected?: boolean }
  ): Promise<number> => {
    generation += 1;
    const takenAt = generation;
    observedVersion = null;
    setChange(null);
    setDismissed(false);
    try {
      const presence = await deps.fileIo.getTextFilePresence(filePath);
      if (!isCurrent(takenAt)) {
        return takenAt;
      }
      baselineError = null;
      baseline =
        presence.kind === "present" ? { kind: "present", version: presence.version } : { kind: "absent" };
      if (presence.kind === "not-a-file") {
        // Whatever this document was going to do with the path, it cannot:
        // this is worth saying even when an empty path was expected.
        raise(filePath, "not-a-file");
      } else if (presence.kind === "missing" && !options?.missingIsExpected) {
        raise(filePath, "deleted");
      }
    } catch (error) {
      if (!isCurrent(takenAt)) {
        return takenAt;
      }
      baseline = null;
      baselineError = new Error(
        `Wisty cannot check this file on disk: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return takenAt;
  };

  /**
   * Compares the file on disk with the baseline, raising or retracting the
   * conflict, and answering whether one now stands.
   */
  const check = async (): Promise<boolean> => {
    if (deps.document.state.kind !== "text" || !deps.document.state.filePath || !baseline) {
      return false;
    }
    const filePath = deps.document.state.filePath;
    const measuredAgainst = baseline;
    const takenAt = generation;
    const current = await deps.fileIo.getTextFilePresence(filePath);
    if (!isCurrent(takenAt) || !documentIsAt(filePath) || baseline !== measuredAgainst) {
      return false;
    }

    if (current.kind === "not-a-file") {
      if (change()?.kind !== "not-a-file") {
        raise(filePath, "not-a-file");
      }
      return true;
    }

    if (current.kind === "missing") {
      if (measuredAgainst.kind === "absent") {
        // Still empty, which is what a document being created here expects.
        retract();
        return false;
      }
      if (change()?.kind !== "deleted") {
        // Raised with no observed version: what comes back after a deletion is
        // judged on its own, and a dismissal of what was there before the file
        // went away is not consent to what replaces it.
        raise(filePath, "deleted");
      }
      return true;
    }

    const version = current.version;
    const differs =
      measuredAgainst.kind === "absent" || !sameTextFileVersion(measuredAgainst.version, version);
    if (differs) {
      if (!observedVersion || !sameTextFileVersion(observedVersion, version)) {
        raise(filePath, measuredAgainst.kind === "absent" ? "appeared" : "changed", version);
      }
      return true;
    }
    // Back to the version this document was opened at — the conflict the banner
    // reported no longer exists, so retract it rather than leave it standing.
    retract();
    return false;
  };

  /**
   * Raises a conflict the backend caught in the moment between the last check
   * and the rename, reading the version that beat it so the banner behaves like
   * any other — dismissible, and retracted if the file comes back.
   */
  const raiseFromSaveRace = async (filePath: string, kind: ExternalChangeKind) => {
    let observed: TextFileVersion | null = null;
    if (kind === "changed" || kind === "appeared") {
      try {
        const presence = await deps.fileIo.getTextFilePresence(filePath);
        observed = presence.kind === "present" ? presence.version : null;
      } catch {
        // Best effort: without it the next check raises the conflict again,
        // which is the safe direction to fail in.
      }
    }
    // A save does not cancel an open. The conflict belongs to the document the
    // save was for, and is not to be raised over the one that replaced it.
    if (!documentIsAt(filePath)) {
      return;
    }
    raise(filePath, kind, observed);
  };

  /** What a save asserts about the target, or nothing when no baseline is held. */
  const expectedSaveSource = (): ExpectedSaveSource | undefined => {
    if (!baseline) {
      return undefined;
    }
    return baseline.kind === "present"
      ? { kind: "present", version: baseline.version }
      : { kind: "absent" };
  };

  return {
    change,
    /** A dismissed conflict still stands; it is only out of the way. */
    isVisible: () => change() !== null && !dismissed(),
    dismiss: () => setDismissed(true),
    /** Raised again after a dismissal, when a save has to insist. */
    undismiss: () => setDismissed(false),
    /** The failure of the last capture, which only Save acts on. */
    error: () => baselineError,
    isCurrent,
    capture,
    clear,
    check,
    raiseFromSaveRace,
    expectedSaveSource
  };
};

export type ExternalChangeMonitor = ReturnType<typeof createExternalChangeMonitor>;
