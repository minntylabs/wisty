/**
 * Opening and saving transcript containers.
 *
 * The save guard is the reason this file exists. A container holds the
 * recording alongside the text, and the ordinary save path streams the
 * editor's text to the document's path — which for a container would replace
 * the archive with plain text and lose the audio. Nothing about that failure
 * would be visible until someone went looking for the recording.
 */

import { describe, expect, it, vi } from "vitest";
import { useFileLifecycle } from "./useFileLifecycle";
import { createDocumentStore } from "../document/documentStore";

const CONTAINER = "/archive/mum_11.tsf";
const TRANSCRIPT = "ALICE: ⟦734.12–736.80⟧So we walked down.";

type HarnessOverrides = {
  containerText?: string;
  openContainer?: (filePath: string) => Promise<{ transcript: string; meta: Record<string, unknown>; audioBytes: number }>;
  saveContainer?: (filePath: string, transcript: string) => Promise<void>;
  setLastDirectory?: () => Promise<void>;
  /**
   * The version on disk, or null for a path with no file. Mapped to the
   * presence the port actually reports, so a test says only what it means.
   */
  getTextFileVersion?: (filePath: string) => Promise<{ size: number; modifiedMs: number | null; device: number | null; inode: number | null } | null>;
  /** For the one state a version cannot describe: something that is not a file. */
  pathIsNotAFile?: () => boolean;
  finishSaveFileStream?: () => Promise<{ bytesWrittenTotal: number }>;
  /** Runs after each streamed chunk is written, so a test can edit mid-save. */
  onWriteChunk?: (chunkNumber: number) => void | Promise<void>;
  /** Runs as each chunk is read, so a test can act while a read is in flight. */
  onReadChunk?: () => void | Promise<void>;
  /** What the open dialog returns. Defaults to the container. */
  dialogPath?: string;
  fileSize?: number;
  confirmOpenLargeFile?: () => Promise<boolean>;
};

const createHarness = (overrides: HarnessOverrides = {}) => {
  const document = createDocumentStore();
  const editorText = { value: "" };
  const revision = { value: 1 };
  /** Ordered log of the calls whose relative order matters. */
  const events: string[] = [];
  const showError = vi.fn(async () => {});
  const openContainer = vi.fn(overrides.openContainer ?? (async () => ({
    transcript: overrides.containerText ?? TRANSCRIPT,
    meta: { tsf_version: 1, audio: { file: "audio.m4a", duration: 1709.61 } },
    audioBytes: 10_780_099
  })));
  const closeContainer = vi.fn(async () => {});
  const saveContainer = vi.fn(overrides.saveContainer ?? (async () => {}));
  const savedChunks: string[] = [];
  const startSaveFileStream = vi.fn(async (filePath: string) => ({ streamId: "s", filePath }));
  const finishSaveFileStream = vi.fn(overrides.finishSaveFileStream ?? (async () => ({ bytesWrittenTotal: 1 })));
  const markersEnabled = vi.fn((enabled: boolean) => {
    events.push(enabled ? "markers-on" : "markers-off");
  });
  const releasePlayback = vi.fn(() => {
    events.push("playback-released");
  });
  const streamReadTextFile = vi.fn(async function* () {
    await overrides.onReadChunk?.();
    yield { text: "plain text", bytesReadTotal: 10, fileSizeBytes: 10 };
  });
  const showFileTooLarge = vi.fn(async () => {});

  const deps = {
    editor: {
      focus: () => {},
      getText: () => editorText.value,
      // Snapshots the text as it is now, exactly as the real adapter does:
      // later edits to editorText.value must not be visible through it.
      snapshotText: () => {
        const text = editorText.value;
        return { length: text.length, revision: revision.value, slice: (from: number, to: number) => text.slice(from, to) };
      },
      setText: (text: string) => {
        events.push("set-text");
        editorText.value = text;
      },
      append: (text: string) => {
        events.push("append-text");
        editorText.value += text;
      },
      reset: () => {
        events.push("reset");
        editorText.value = "";
      },
      setLargeLineSafeMode: () => {},
      setMarkersEnabled: markersEnabled,
      getRevision: () => revision.value
    },
    document,
    settings: {
      state: { lastDirectory: "", recentFiles: [] },
      actions: {
        setLastDirectory: overrides.setLastDirectory ?? (async () => {}),
        addRecentFile: async () => {},
        removeRecentFile: async () => {}
      }
    },
    fileDialogs: {
      openTextFilePath: async () => ({
        kind: "opened" as const,
        filePath: overrides.dialogPath ?? CONTAINER
      }),
      saveTextFilePathAs: async () => ({ kind: "saved" as const, filePath: "/tmp/other.txt" }),
      saveContainerPathAs: async () => ({ kind: "saved" as const, filePath: "/tmp/other.tsf" }),
      saveTextExportPathAs: async () => ({ kind: "saved" as const, filePath: "/tmp/export.txt" })
    },
    fileIo: {
      getFileSize: async () => overrides.fileSize ?? 10,
      getTextFilePresence: async (filePath: string) => {
        if (overrides.pathIsNotAFile?.()) {
          return { kind: "not-a-file" as const };
        }
        const version = await (overrides.getTextFileVersion ?? (async () => null))(filePath);
        return version ? { kind: "present" as const, version } : { kind: "missing" as const };
      },
      fileExists: async () => true,
      readTextFile: async () => "plain text",
      streamReadTextFile,
      saveTextFile: async () => {},
      getDirectoryFromFilePath: () => "/archive",
      isContainerPath: (filePath: string) => filePath.toLowerCase().endsWith(".tsf"),
      openContainer,
      closeContainer,
      saveContainer
    },
    launchFileStream: {
      startLaunchFileStream: async (filePath: string) => ({ streamId: "l", filePath, fileSizeBytes: 10 }),
      readLaunchFileChunk: async () => ({ kind: "eof" as const, bytesReadTotal: 0, fileSizeBytes: 0 }),
      cancelLaunchFileStream: async () => {},
      closeLaunchFileStream: async () => {}
    },
    saveFileStream: {
      startSaveFileStream,
      writeSaveFileChunk: async (_streamId: string, chunk: string) => {
        savedChunks.push(chunk);
        await overrides.onWriteChunk?.(savedChunks.length);
        return { bytesWrittenTotal: savedChunks.join("").length };
      },
      finishSaveFileStream,
      cancelSaveFileStream: async () => {}
    },
    fontPicker: { chooseEditorFont: async () => null },
    rememberedPosition: {
      capture: async () => {},
      restore: () => {},
      migrate: async () => {}
    },
    errors: { showError },
    playback: { release: releasePlayback },
    confirmOpenLargeFile: overrides.confirmOpenLargeFile ?? (async () => true),
    showFileTooLarge
  } as unknown as Parameters<typeof useFileLifecycle>[0];

  return {
    lifecycle: useFileLifecycle(deps),
    document,
    editorText,
    revision,
    showError,
    openContainer,
    closeContainer,
    saveContainer,
    savedChunks,
    startSaveFileStream,
    finishSaveFileStream,
    streamReadTextFile,
    showFileTooLarge,
    markersEnabled,
    releasePlayback,
    events
  };
};

/**
 * Waits for a container save to have actually begun.
 *
 * Saving a container now checks the file on disk first, so the write starts a
 * few microtasks after the call rather than immediately; a single flush would
 * see it not yet under way.
 */
const untilSaving = async (h: ReturnType<typeof createHarness>) => {
  for (let attempt = 0; attempt < 20 && !h.lifecycle.savingState.isSaving(); attempt += 1) {
    await Promise.resolve();
  }
};

describe("opening a container", () => {
  it("loads its transcript into the editor", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    expect(h.editorText.value).toBe(TRANSCRIPT);
  });

  it("marks the document as a container, not as text", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    expect(h.document.state.kind).toBe("container");
    expect(h.document.state.filePath).toBe(CONTAINER);
  });

  it("never reads it through the text stream", async () => {
    // The streaming reader decodes as UTF-8, which a zip is not.
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    expect(h.streamReadTextFile).not.toHaveBeenCalled();
    expect(h.openContainer).toHaveBeenCalledWith(CONTAINER);
  });

  it("takes the same path when opened from a launch argument", async () => {
    const h = createHarness();
    await h.lifecycle.openLaunchFileAtPath(CONTAINER, 10_800_000);
    expect(h.document.state.kind).toBe("container");
    expect(h.editorText.value).toBe(TRANSCRIPT);
  });

  it("takes the same path through the open dialog", async () => {
    const h = createHarness();
    await h.lifecycle.openFile();
    expect(h.document.state.kind).toBe("container");
  });

  it("keeps the open container usable when its replacement cannot open", async () => {
    const h = createHarness({
      openContainer: async (path) => {
        if (path === "/archive/bad.tsf") {
          throw new Error("bad archive");
        }
        return {
          transcript: TRANSCRIPT,
          meta: { tsf_version: 1, audio: { file: "audio.m4a", duration: 1709.61 } },
          audioBytes: 10_780_099
        };
      }
    });
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.closeContainer.mockClear();
    h.markersEnabled.mockClear();
    h.releasePlayback.mockClear();

    await h.lifecycle.openFileAtPath("/archive/bad.tsf");

    expect(h.document.state).toMatchObject({ kind: "container", filePath: CONTAINER });
    expect(h.editorText.value).toBe(TRANSCRIPT);
    expect(h.closeContainer).not.toHaveBeenCalled();
    expect(h.releasePlayback).not.toHaveBeenCalled();
    expect(h.markersEnabled).not.toHaveBeenCalledWith(false);
  });

  /**
   * The dialog path opening a PLAIN FILE while a container is open.
   *
   * This went unnoticed because every test of openFile handed it a .tsf, so the
   * branch that skipped releasing was never taken. The consequences are all
   * silent: the recording stays resident, the marker extension stays installed
   * over a text file so a stray ⟦…⟧ renders a speaker icon, and playback stays
   * armed against the recording of the transcript the user just closed.
   */
  describe("opening a plain file through the dialog", () => {
    const openTextViaDialog = async () => {
      const h = createHarness({ dialogPath: "/tmp/notes.txt" });
      await h.lifecycle.openFileAtPath(CONTAINER);
      h.closeContainer.mockClear();
      h.markersEnabled.mockClear();
      h.releasePlayback.mockClear();
      await h.lifecycle.openFile();
      return h;
    };

    it("releases the container", async () => {
      const h = await openTextViaDialog();
      expect(h.closeContainer).toHaveBeenCalled();
      expect(h.document.state.kind).toBe("text");
    });

    it("turns the markers off", async () => {
      const h = await openTextViaDialog();
      expect(h.markersEnabled).toHaveBeenLastCalledWith(false);
    });

    it("stops playback", async () => {
      const h = await openTextViaDialog();
      expect(h.releasePlayback).toHaveBeenCalled();
    });
  });

  it("leaves the open container alone when a large-file prompt is declined", async () => {
    // The release belongs with the load, not with the branch: backing out here
    // must not strip the markers from the transcript still on screen.
    const h = createHarness({
      dialogPath: "/tmp/huge.txt",
      fileSize: 60 * 1024 * 1024, // over the 50MB soft limit, so it prompts
      confirmOpenLargeFile: async () => false
    });
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.closeContainer.mockClear();

    await h.lifecycle.openFile();
    expect(h.closeContainer).not.toHaveBeenCalled();
    expect(h.document.state.kind).toBe("container");
  });
});

describe("marker handling follows the document", () => {
  it("is switched on for a container", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    expect(h.markersEnabled).toHaveBeenLastCalledWith(true);
  });

  it("is switched on before the text arrives, not after", async () => {
    // Otherwise the markers would be found by a later edit rather than being
    // tracked from the moment the document loads.
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    expect(h.events).toEqual([
      "markers-on",
      "reset",
      "append-text"
    ]);
  });

  it("is switched off for an ordinary text file", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.markersEnabled.mockClear();

    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    expect(h.markersEnabled).toHaveBeenLastCalledWith(false);
  });

  it("is switched off for a new empty document", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.markersEnabled.mockClear();

    await h.lifecycle.newFile();
    expect(h.markersEnabled).toHaveBeenLastCalledWith(false);
  });

  it("is switched off when loading text at a path", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.markersEnabled.mockClear();

    await h.lifecycle.openFileFromTextAtPath("/tmp/notes.txt", "plain");
    expect(h.markersEnabled).toHaveBeenLastCalledWith(false);
  });
});

describe("releasing the recording", () => {
  it("releases the previous container before opening a text file", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.closeContainer.mockClear();

    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    expect(h.closeContainer).toHaveBeenCalled();
    expect(h.document.state.kind).toBe("text");
  });

  it("releases it when a new empty document is started", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.closeContainer.mockClear();

    await h.lifecycle.openFileFromTextAtPath("/tmp/other.txt", "text");
    expect(h.closeContainer).toHaveBeenCalled();
  });

  it("opens the file even if releasing the previous one fails", async () => {
    const h = createHarness();
    h.closeContainer.mockRejectedValueOnce(new Error("lock poisoned"));
    await h.lifecycle.openFileAtPath(CONTAINER);
    expect(h.editorText.value).toBe(TRANSCRIPT);
  });

  it("stops playback when the document closes", async () => {
    // Audio outliving the transcript it came from is both confusing and a way
    // to keep the recording resident after the user has moved on. Asserted
    // rather than assumed, because nothing about it is visible until it is
    // wrong and then it is a voice talking over the next document.
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.releasePlayback.mockClear();

    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    expect(h.releasePlayback).toHaveBeenCalled();
  });

  it("stops playback before the container is released, not after", async () => {
    // The recording lives in the same Rust state playback reads from, so the
    // order is not cosmetic: releasing the container first would leave the
    // player pointed at bytes that are on their way out.
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.events.length = 0;
    h.releasePlayback.mockClear();
    h.closeContainer.mockClear();
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    const released = h.events.indexOf("playback-released");
    expect(released).toBeGreaterThanOrEqual(0);
    expect(h.releasePlayback.mock.invocationCallOrder[0]).toBeLessThan(
      h.closeContainer.mock.invocationCallOrder[0]
    );
  });
});

describe("saving a container", () => {
  it("repacks its transcript without using the text stream", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.editorText.value = "ALICE: edited";

    await h.lifecycle.saveFile();

    expect(h.startSaveFileStream).not.toHaveBeenCalled();
    expect(h.saveContainer).toHaveBeenCalledWith(CONTAINER, "ALICE: edited");
    expect(h.showError).not.toHaveBeenCalled();
  });

  it("blocks a second container save until the first completes", async () => {
    let finishSave: (() => void) | undefined;
    const h = createHarness({
      saveContainer: async () => new Promise<void>((resolve) => {
        finishSave = resolve;
      })
    });
    await h.lifecycle.openFileAtPath(CONTAINER);

    const first = h.lifecycle.saveFile();
    await untilSaving(h);
    expect(h.lifecycle.savingState.isSaving()).toBe(true);
    await h.lifecycle.saveFile();
    expect(h.saveContainer).toHaveBeenCalledTimes(1);

    finishSave?.();
    await first;
    expect(h.lifecycle.savingState.isSaving()).toBe(false);
  });

  it("keeps an edit made during a container save dirty", async () => {
    let finishSave: (() => void) | undefined;
    const h = createHarness({
      saveContainer: async () => new Promise<void>((resolve) => {
        finishSave = resolve;
      })
    });
    await h.lifecycle.openFileAtPath(CONTAINER);

    const saving = h.lifecycle.saveFile();
    await untilSaving(h);
    h.editorText.value = `${TRANSCRIPT} Later edit.`;
    h.revision.value = 2;
    h.document.setRevision(2);
    finishSave?.();
    await saving;

    expect(h.document.state.isDirty).toBe(true);
    expect(h.document.state.baselineRevision).toBe(1);
  });

  it("keeps the saved-as container active when directory history fails", async () => {
    let directoryUpdates = 0;
    const h = createHarness({
      setLastDirectory: async () => {
        directoryUpdates += 1;
        if (directoryUpdates > 1) {
          throw new Error("settings unavailable");
        }
      }
    });
    await h.lifecycle.openFileAtPath(CONTAINER);

    await h.lifecycle.saveFileAs();

    expect(h.document.state).toMatchObject({ kind: "container", filePath: "/tmp/other.tsf" });
    expect(h.showError).not.toHaveBeenCalled();
  });

  it("saves a container copy as another .tsf", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);

    await h.lifecycle.saveFileAs();

    expect(h.startSaveFileStream).not.toHaveBeenCalled();
    expect(h.saveContainer).toHaveBeenCalledWith("/tmp/other.tsf", TRANSCRIPT);
    expect(h.document.state).toMatchObject({ kind: "container", filePath: "/tmp/other.tsf" });
  });

  it("exports plain text without changing the open container", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.document.setRevision(9);
    await h.lifecycle.exportText();

    expect(h.saveContainer).not.toHaveBeenCalled();
    expect(h.startSaveFileStream).toHaveBeenCalledWith("/tmp/export.txt");
    expect(h.savedChunks.join("")).toBe("ALICE: So we walked down.");
    expect(h.document.state).toMatchObject({ kind: "container", filePath: CONTAINER });
    expect(h.document.state.isDirty).toBe(true);
  });

  it("still saves an ordinary text document", async () => {
    const h = createHarness();
    await h.lifecycle.openFileFromTextAtPath("/tmp/notes.txt", "hello");

    await h.lifecycle.saveFile();

    // The harness has no file at that path, so the save asserts there is none:
    // it is creating the file, not overwriting one it has read.
    expect(h.startSaveFileStream).toHaveBeenCalledWith("/tmp/notes.txt", { kind: "absent" });
    expect(h.showError).not.toHaveBeenCalled();
  });
});

describe("saving a text document while it is being edited", () => {
  /** Long enough to need more than one streamed chunk. */
  const LONG_TEXT = "a".repeat(300_000);

  it("writes the text as it was when the save began", async () => {
    const h = createHarness({
      onWriteChunk: (chunkNumber) => {
        if (chunkNumber === 1) {
          // The user types while the first chunk is in flight. Reading the live
          // editor for the remaining chunks would write a file matching neither
          // version of the document.
          h.editorText.value = "replaced";
          h.revision.value = 2;
          h.document.setRevision(2);
        }
      }
    });
    await h.lifecycle.openFileFromTextAtPath("/tmp/notes.txt", "seed");
    h.editorText.value = LONG_TEXT;

    await h.lifecycle.saveFile();

    expect(h.savedChunks.length).toBeGreaterThan(1);
    expect(h.savedChunks.join("")).toBe(LONG_TEXT);
    expect(h.showError).not.toHaveBeenCalled();
  });

  it("keeps the document dirty at the edit made during the save", async () => {
    const h = createHarness({
      onWriteChunk: (chunkNumber) => {
        if (chunkNumber === 1) {
          h.revision.value = 2;
          h.document.setRevision(2);
        }
      }
    });
    await h.lifecycle.openFileFromTextAtPath("/tmp/notes.txt", "seed");
    h.editorText.value = LONG_TEXT;

    await h.lifecycle.saveFile();

    expect(h.document.state.isDirty).toBe(true);
    expect(h.document.state.baselineRevision).toBe(1);
  });

  it("reports a successful save when directory history fails", async () => {
    let directoryUpdates = 0;
    const h = createHarness({
      // The open path records a directory too; only the one after the save
      // should be able to fail without the save being reported as failed.
      setLastDirectory: async () => {
        directoryUpdates += 1;
        if (directoryUpdates > 1) {
          throw new Error("settings unavailable");
        }
      }
    });
    await h.lifecycle.openFileFromTextAtPath("/tmp/notes.txt", "hello");

    await h.lifecycle.saveFile();

    expect(h.savedChunks.join("")).toBe("hello");
    expect(h.showError).not.toHaveBeenCalled();
  });
});

describe("external text-file changes", () => {
  const original = { size: 10, modifiedMs: 1_000, device: 1, inode: 2 };

  it("shows a conflict and blocks an ordinary save when the file changed", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    version = { ...original, modifiedMs: 2_000 };

    await h.lifecycle.checkForExternalChange();
    h.lifecycle.dismissExternalChange();
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(false);
    await h.lifecycle.saveFile();

    expect(h.lifecycle.externalChangeState.change()).toEqual({ filePath: "/tmp/notes.txt", kind: "changed" });
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(true);
    expect(h.startSaveFileStream).not.toHaveBeenCalled();
  });

  it("allows an explicit overwrite after an external change", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();

    await h.lifecycle.overwriteExternalChange();

    expect(h.startSaveFileStream).toHaveBeenCalledWith("/tmp/notes.txt");
    expect(h.lifecycle.externalChangeState.change()).toBeNull();
  });

  it("retracts the conflict when the file returns to the version it was opened at", async () => {
    let version: typeof original | null = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(true);

    version = original;
    await expect(h.lifecycle.checkForExternalChange()).resolves.toBe(false);
    expect(h.lifecycle.externalChangeState.change()).toBeNull();
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(false);
  });

  it("reopens the conflict for content that replaces a deleted file", async () => {
    let version: typeof original | null = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();
    h.lifecycle.dismissExternalChange();

    version = null;
    await h.lifecycle.checkForExternalChange();
    expect(h.lifecycle.externalChangeState.change()).toEqual({ filePath: "/tmp/notes.txt", kind: "deleted" });

    // The same version as before the deletion, but a fresh file: the earlier
    // dismissal cannot stand in for consent to this one.
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();
    expect(h.lifecycle.externalChangeState.change()).toEqual({ filePath: "/tmp/notes.txt", kind: "changed" });
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(true);
  });

  it("marks a deleted file's document unsaved, so closing it has to ask", async () => {
    let version: typeof original | null = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    expect(h.document.state.isDirty).toBe(false);

    version = null;
    await h.lifecycle.checkForExternalChange();

    expect(h.document.state.isDirty).toBe(true);
  });

  it("reports a save that succeeded as a save, even when the baseline cannot be retaken", async () => {
    let written = false;
    const h = createHarness({
      // The versions taken after the write lands, and only those, fail.
      getTextFileVersion: async () => {
        if (written) {
          throw new Error("Permission denied (os error 13)");
        }
        return original;
      },
      finishSaveFileStream: async () => {
        written = true;
        return { bytesWrittenTotal: 1 };
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    await h.lifecycle.saveFile();

    expect(h.finishSaveFileStream).toHaveBeenCalled();
    expect(h.showError).not.toHaveBeenCalled();
    expect(h.document.state.isDirty).toBe(false);
  });

  it("retakes a failed baseline on the next save rather than locking the document", async () => {
    let failVersion = true;
    const h = createHarness({
      getTextFileVersion: async () => {
        if (failVersion) {
          throw new Error("Permission denied (os error 13)");
        }
        return original;
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    await h.lifecycle.saveFile();
    expect(h.startSaveFileStream).not.toHaveBeenCalled();
    expect(h.showError).toHaveBeenCalledWith(
      "Unable to save file",
      expect.objectContaining({ message: expect.stringContaining("cannot check this file on disk") })
    );

    failVersion = false;
    await h.lifecycle.saveFile();

    expect(h.startSaveFileStream).toHaveBeenCalledWith("/tmp/notes.txt", {
      kind: "present",
      version: original
    });
  });

  it("leaves a document opened during a save alone when the save lands", async () => {
    let opened = false;
    const h: ReturnType<typeof createHarness> = createHarness({
      getTextFileVersion: async () => original,
      onWriteChunk: async () => {
        if (opened) {
          return;
        }
        opened = true;
        // A save does not cancel an open, so what this save learned about its
        // own document — its saved revision — must not land on the document
        // that replaced it. The open finishes first, so the only thing that can
        // mark the new document clean at the old one's revision is the save.
        h.revision.value = 5;
        await h.lifecycle.openFileAtPath("/tmp/other.txt");
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    h.editorText.value = "edited";

    await h.lifecycle.saveFile();

    expect(h.document.state.filePath).toBe("/tmp/other.txt");
    expect(h.document.state.isDirty).toBe(false);
  });

  it("retains a deleted file's text instead of reloading it as empty", async () => {
    let version: typeof original | null = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    version = null;

    await h.lifecycle.checkForExternalChange();

    expect(h.lifecycle.externalChangeState.change()).toEqual({ filePath: "/tmp/notes.txt", kind: "deleted" });
    expect(h.editorText.value).toBe("plain text");
  });

  it("shows a conflict instead of an error when the backend catches a final save race", async () => {
    const h = createHarness({
      getTextFileVersion: async () => original,
      // Shaped as Rust reports it: a code the frontend can act on, and a
      // message it would only ever display.
      finishSaveFileStream: async () => {
        throw {
          code: "SAVE_EXTERNAL_CHANGE",
          message: "The file changed on disk after it was opened."
        };
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    await h.lifecycle.saveFile();

    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: "/tmp/notes.txt",
      kind: "changed"
    });
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(true);
    expect(h.showError).not.toHaveBeenCalled();
  });

  /**
   * A conflict the backend raised is dismissible like any other. It records the
   * version it was raised for, so the next check recognises it rather than
   * putting the banner straight back.
   */
  it("keeps a dismissal of a conflict the backend raised", async () => {
    let version = original;
    const h = createHarness({
      getTextFileVersion: async () => version,
      finishSaveFileStream: async () => {
        // The writer that beat the save also moved the version on disk.
        version = { ...original, modifiedMs: 2_000 };
        throw { code: "SAVE_EXTERNAL_CHANGE", message: "The file changed on disk." };
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    await h.lifecycle.saveFile();
    h.lifecycle.dismissExternalChange();
    await h.lifecycle.checkForExternalChange();

    expect(h.lifecycle.externalChangeState.isVisible()).toBe(false);
  });

  it("reports a deletion the backend catches as a deletion, not a change", async () => {
    const h = createHarness({
      getTextFileVersion: async () => original,
      finishSaveFileStream: async () => {
        throw { code: "SAVE_EXTERNAL_DELETE", message: "The file was deleted on disk." };
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    await h.lifecycle.saveFile();

    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: "/tmp/notes.txt",
      kind: "deleted"
    });
  });

  it("takes the baseline before the read, so a file rewritten during it is a conflict", async () => {
    let version = original;
    const h = createHarness({
      getTextFileVersion: async () => version,
      // The write lands while the file is still streaming into the editor.
      onReadChunk: () => {
        version = { ...original, modifiedMs: 2_000 };
      }
    });

    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: "/tmp/notes.txt",
      kind: "changed"
    });
    expect(h.startSaveFileStream).not.toHaveBeenCalled();
  });

  it("clears the conflict when a reload fails, rather than acting on a path it has left", async () => {
    let version: typeof original | null = original;
    let failRead = false;
    const h = createHarness({
      getTextFileVersion: async () => version,
      onReadChunk: () => {
        if (failRead) {
          throw new Error("Input/output error (os error 5)");
        }
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(true);

    failRead = true;
    await h.lifecycle.reloadExternalChange();

    expect(h.showError).toHaveBeenCalled();
    expect(h.lifecycle.externalChangeState.change()).toBeNull();
  });

  it("refuses to reload a file that has grown past the hard limit", async () => {
    let version = original;
    const h = createHarness({
      getTextFileVersion: async () => version,
      fileSize: 2 * 1024 * 1024 * 1024
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();

    await h.lifecycle.reloadExternalChange();

    expect(h.showFileTooLarge).toHaveBeenCalled();
    // The conflict stands: nothing about it has been resolved.
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(true);
  });
});

/**
 * A document created at a path that holds no file. Its baseline is the absence
 * itself: without one, a save has nothing to assert and silently overwrites
 * whatever arrived at that path in the meantime.
 */
describe("a document created at an empty path", () => {
  const created = { size: 3, modifiedMs: 5_000, device: 1, inode: 9 };

  it("asserts the path is still empty when it saves", async () => {
    const h = createHarness({ getTextFileVersion: async () => null });
    await h.lifecycle.openMissingFileAtPath("/tmp/new.txt");

    await h.lifecycle.saveFile();

    expect(h.startSaveFileStream).toHaveBeenCalledWith("/tmp/new.txt", { kind: "absent" });
  });

  it("does not report the absent file it was opened for as a deletion", async () => {
    const h = createHarness({ getTextFileVersion: async () => null });

    await h.lifecycle.openMissingFileAtPath("/tmp/new.txt");

    expect(h.lifecycle.externalChangeState.change()).toBeNull();
    expect(h.document.state.isDirty).toBe(false);
  });

  it("raises a conflict when a file appears at the path, and blocks the save", async () => {
    let version: typeof created | null = null;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openMissingFileAtPath("/tmp/new.txt");

    version = created;
    await expect(h.lifecycle.checkForExternalChange()).resolves.toBe(true);
    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: "/tmp/new.txt",
      kind: "appeared"
    });

    await h.lifecycle.saveFile();
    expect(h.startSaveFileStream).not.toHaveBeenCalled();
  });

  it("retracts the conflict when the file that appeared goes away again", async () => {
    let version: typeof created | null = null;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openMissingFileAtPath("/tmp/new.txt");
    version = created;
    await h.lifecycle.checkForExternalChange();

    version = null;
    await expect(h.lifecycle.checkForExternalChange()).resolves.toBe(false);
    expect(h.lifecycle.externalChangeState.change()).toBeNull();
  });
});

/**
 * The file going missing around a save is a deletion the user has to see —
 * including when it is the baseline retaken afterwards that discovers it.
 */
describe("a file deleted while it is being saved", () => {
  const original = { size: 10, modifiedMs: 1_000, device: 1, inode: 2 };

  it("reports a deletion the retaken baseline discovers, instead of saving over it", async () => {
    let version: typeof original | null = original;
    let failVersion = false;
    const h = createHarness({
      getTextFileVersion: async () => {
        if (failVersion) {
          throw new Error("Permission denied (os error 13)");
        }
        return version;
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    // The baseline is lost to a fault, and by the time Save retakes it the
    // file has gone. Saving straight over that would recreate it in silence.
    failVersion = true;
    await h.lifecycle.saveFile();
    failVersion = false;
    version = null;

    await h.lifecycle.saveFile();

    expect(h.startSaveFileStream).not.toHaveBeenCalled();
    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: "/tmp/notes.txt",
      kind: "deleted"
    });
    expect(h.document.state.isDirty).toBe(true);
  });
});

/**
 * Opening a document does not cancel the read, save or metadata lookup already
 * running for the last one. What those learned about their own document has to
 * stay with it — the danger being a new document left holding an old one's
 * baseline, or none at all, either of which lets its next save assert the
 * wrong thing about the file it is about to overwrite.
 */
describe("a document replaced while the last one was still being measured", () => {
  const original = { size: 10, modifiedMs: 1_000, device: 1, inode: 2 };
  const other = { size: 20, modifiedMs: 9_000, device: 1, inode: 7 };
  const versionForPath = async (filePath: string) =>
    filePath === "/tmp/other.txt" ? other : original;

  it("keeps the baseline of the document that replaced it mid-read", async () => {
    let opened = false;
    const h: ReturnType<typeof createHarness> = createHarness({
      getTextFileVersion: versionForPath,
      onReadChunk: async () => {
        if (opened) {
          return;
        }
        opened = true;
        // The read of the first file is cancelled by this open, and the
        // failure that cancellation raises must not take the new document's
        // baseline down with it.
        await h.lifecycle.openFileAtPath("/tmp/other.txt");
      }
    });

    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    await h.lifecycle.saveFile();

    expect(h.startSaveFileStream).toHaveBeenCalledWith("/tmp/other.txt", {
      kind: "present",
      version: other
    });
  });

  it("does not hand it the baseline the last document was taking", async () => {
    let releaseBaseline: (() => void) | null = null;
    const inFlight = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    let baselineStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      baselineStarted = resolve;
    });
    let written = false;
    let held = false;
    const h = createHarness({
      getTextFileVersion: async (filePath) => {
        // The baseline retaken after the write is still in flight when the
        // next document arrives.
        if (written && !held) {
          held = true;
          baselineStarted!();
          await inFlight;
        }
        return versionForPath(filePath);
      },
      finishSaveFileStream: async () => {
        written = true;
        return { bytesWrittenTotal: 1 };
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    const saving = h.lifecycle.saveFile();
    // Not before: the save has to have passed its own "is this still my
    // document" guard, or it never reaches the baseline this test is about.
    await started;
    await h.lifecycle.openFileAtPath("/tmp/other.txt");
    releaseBaseline!();
    await saving;

    await h.lifecycle.saveFile();

    expect(h.startSaveFileStream).toHaveBeenLastCalledWith("/tmp/other.txt", {
      kind: "present",
      version: other
    });
  });

  it("does not raise the last document's save conflict over it", async () => {
    let opened = false;
    const h: ReturnType<typeof createHarness> = createHarness({
      getTextFileVersion: versionForPath,
      onWriteChunk: async () => {
        if (opened) {
          return;
        }
        opened = true;
        await h.lifecycle.openFileAtPath("/tmp/other.txt");
      },
      finishSaveFileStream: async () => {
        throw { code: "SAVE_EXTERNAL_CHANGE", message: "The file changed on disk." };
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    h.editorText.value = "edited";

    await h.lifecycle.saveFile();

    expect(h.lifecycle.externalChangeState.change()).toBeNull();
  });
});

/**
 * Reload from Disk does not run at the moment it is clicked: a dirty document
 * sends it through the discard confirmation first, and the world can move while
 * that prompt is open.
 */
describe("reloading after the discard prompt", () => {
  const original = { size: 10, modifiedMs: 1_000, device: 1, inode: 2 };

  it("reloads the file it was asked for, even once the conflict has gone", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();

    // The file is put back as it was while the prompt is open, so the banner
    // is retracted. The reload the user confirmed still has to happen.
    version = original;
    await h.lifecycle.checkForExternalChange();
    expect(h.lifecycle.externalChangeState.change()).toBeNull();

    await h.lifecycle.reloadExternalChange("/tmp/notes.txt");

    expect(h.streamReadTextFile).toHaveBeenCalledTimes(2);
  });

  it("does not reload over the document that replaced it", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();

    await h.lifecycle.openFileAtPath("/tmp/other.txt");
    await h.lifecycle.reloadExternalChange("/tmp/notes.txt");

    expect(h.streamReadTextFile).toHaveBeenCalledTimes(2);
    expect(h.document.state.filePath).toBe("/tmp/other.txt");
  });
});

/**
 * The banner's actions are not in the command pipeline, so the invariant the
 * pipeline enforces for every menu item — one file operation at a time — has
 * to be enforced where the actions are, not only by disabling their buttons.
 */
describe("banner actions while a file operation runs", () => {
  const original = { size: 10, modifiedMs: 1_000, device: 1, inode: 2 };

  it("does not start a second overwrite while the first is streaming", async () => {
    // The banner stays up for the whole of the save it started — the conflict
    // is only cleared once the write lands — so a second click is one button
    // press away, and it would cancel the save already running.
    let secondOverwrite: Promise<void> | null = null;
    let version = original;
    const h: ReturnType<typeof createHarness> = createHarness({
      getTextFileVersion: async () => version,
      onWriteChunk: () => {
        secondOverwrite ??= h.lifecycle.overwriteExternalChange();
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    h.editorText.value = "edited";
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();

    await h.lifecycle.overwriteExternalChange();
    await secondOverwrite;

    expect(h.startSaveFileStream).toHaveBeenCalledTimes(1);
  });

  it("does not reload the editor out from under a save", async () => {
    let reloadDuringSave: Promise<void> | null = null;
    const h: ReturnType<typeof createHarness> = createHarness({
      getTextFileVersion: async () => original,
      onWriteChunk: () => {
        reloadDuringSave ??= h.lifecycle.reloadExternalChange("/tmp/notes.txt");
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    h.editorText.value = "edited";
    const readsAfterOpen = h.streamReadTextFile.mock.calls.length;

    await h.lifecycle.saveFile();
    await reloadDuringSave;

    expect(h.streamReadTextFile.mock.calls.length).toBe(readsAfterOpen);
  });
});

/**
 * A path that holds something other than a regular file — a directory left
 * where the document's file was. It is neither a deletion nor a change: there
 * is nothing to read back and nothing a rename can replace, so it has to be
 * described as itself rather than borrow either of their descriptions.
 */
describe("a path that is no longer a file", () => {
  const original = { size: 10, modifiedMs: 1_000, device: 1, inode: 2 };

  it("is reported as its own conflict, not as a deletion", async () => {
    let notAFile = false;
    const h = createHarness({
      getTextFileVersion: async () => original,
      pathIsNotAFile: () => notAFile
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    notAFile = true;
    await expect(h.lifecycle.checkForExternalChange()).resolves.toBe(true);

    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: "/tmp/notes.txt",
      kind: "not-a-file"
    });
  });

  it("marks the document unsaved, since the editor holds the only copy", async () => {
    let notAFile = false;
    const h = createHarness({
      getTextFileVersion: async () => original,
      pathIsNotAFile: () => notAFile
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    expect(h.document.state.isDirty).toBe(false);

    notAFile = true;
    await h.lifecycle.checkForExternalChange();

    expect(h.document.state.isDirty).toBe(true);
  });

  it("blocks an ordinary save rather than writing into it", async () => {
    let notAFile = false;
    const h = createHarness({
      getTextFileVersion: async () => original,
      pathIsNotAFile: () => notAFile
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    notAFile = true;
    await h.lifecycle.saveFile();

    expect(h.startSaveFileStream).not.toHaveBeenCalled();
    expect(h.lifecycle.externalChangeState.change()?.kind).toBe("not-a-file");
  });

  /**
   * Even for a document creating a file: an empty path was expected, and a
   * directory is not an empty path.
   */
  it("is reported for a document created where a directory now stands", async () => {
    const h = createHarness({ pathIsNotAFile: () => true });

    await h.lifecycle.openMissingFileAtPath("/tmp/new.txt");

    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: "/tmp/new.txt",
      kind: "not-a-file"
    });
  });

  it("does not offer to reload from it", async () => {
    let notAFile = false;
    const h = createHarness({
      getTextFileVersion: async () => original,
      pathIsNotAFile: () => notAFile
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    notAFile = true;
    await h.lifecycle.checkForExternalChange();
    const readsBefore = h.streamReadTextFile.mock.calls.length;

    await h.lifecycle.reloadExternalChange();

    expect(h.streamReadTextFile.mock.calls.length).toBe(readsBefore);
  });

  it("takes the conflict the backend reports when it catches one at the rename", async () => {
    const h = createHarness({
      getTextFileVersion: async () => original,
      finishSaveFileStream: async () => {
        throw { code: "SAVE_EXTERNAL_NOT_A_FILE", message: "This path is no longer a file." };
      }
    });
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");

    await h.lifecycle.saveFile();

    expect(h.lifecycle.externalChangeState.change()?.kind).toBe("not-a-file");
    expect(h.showError).not.toHaveBeenCalled();
  });
});

/**
 * A container is a file on disk like any other, and the one where being
 * changed underneath costs a recording rather than some text. It gets the same
 * conflict banner — with the actions pointed at its own reader and writer,
 * since the text ones would read the archive as text and write plain text over
 * it.
 */
describe("a container changed outside Wisty", () => {
  const original = { size: 4096, modifiedMs: 1_000, device: 1, inode: 2 };

  it("raises a conflict, as a text file does", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath(CONTAINER);

    version = { ...original, modifiedMs: 2_000 };
    await expect(h.lifecycle.checkForExternalChange()).resolves.toBe(true);

    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: CONTAINER,
      kind: "changed"
    });
  });

  it("blocks an ordinary save while the conflict stands", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath(CONTAINER);
    version = { ...original, modifiedMs: 2_000 };

    await h.lifecycle.saveFile();

    expect(h.saveContainer).not.toHaveBeenCalled();
    expect(h.lifecycle.externalChangeState.isVisible()).toBe(true);
  });

  /** The text writer would put the transcript where the archive was. */
  it("overwrites through the container writer, not the text one", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath(CONTAINER);
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();

    await h.lifecycle.overwriteExternalChange();

    expect(h.saveContainer).toHaveBeenCalledWith(CONTAINER, TRANSCRIPT);
    expect(h.startSaveFileStream).not.toHaveBeenCalled();
    expect(h.lifecycle.externalChangeState.change()).toBeNull();
  });

  /** And the text reader would read a zip as UTF-8. */
  it("reloads through the container reader, not the text one", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath(CONTAINER);
    version = { ...original, modifiedMs: 2_000 };
    await h.lifecycle.checkForExternalChange();
    const opensBefore = h.openContainer.mock.calls.length;

    await h.lifecycle.reloadExternalChange();

    expect(h.openContainer.mock.calls.length).toBe(opensBefore + 1);
    expect(h.streamReadTextFile).not.toHaveBeenCalled();
    expect(h.lifecycle.externalChangeState.change()).toBeNull();
  });

  it("takes a fresh baseline once it has been saved", async () => {
    let version = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath(CONTAINER);

    // The save rewrites the container, so what is on disk is new.
    version = { ...original, modifiedMs: 5_000 };
    await h.lifecycle.saveFileAs();

    await expect(h.lifecycle.checkForExternalChange()).resolves.toBe(false);
    expect(h.lifecycle.externalChangeState.change()).toBeNull();
  });

  it("reports a container deleted on disk", async () => {
    let version: typeof original | null = original;
    const h = createHarness({ getTextFileVersion: async () => version });
    await h.lifecycle.openFileAtPath(CONTAINER);

    version = null;
    await h.lifecycle.checkForExternalChange();

    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: CONTAINER,
      kind: "deleted"
    });
    expect(h.document.state.isDirty).toBe(true);
  });
});

describe("a container save that outlives its document", () => {
  it("does not land on the document that replaced it", async () => {
    let finishSave: (() => void) | undefined;
    const h: ReturnType<typeof createHarness> = createHarness({
      saveContainer: async () => new Promise<void>((resolve) => {
        finishSave = resolve;
      })
    });
    await h.lifecycle.openFileAtPath(CONTAINER);

    const saving = h.lifecycle.saveFile();
    await untilSaving(h);
    // A save does not cancel an open, and this one lands after it.
    await h.lifecycle.openFileAtPath("/tmp/notes.txt");
    finishSave?.();
    await saving;

    expect(h.document.state.filePath).toBe("/tmp/notes.txt");
    expect(h.document.state.kind).toBe("text");
  });
});

describe("a container that goes missing as it opens", () => {
  const version = { size: 4096, modifiedMs: 1_000, device: 1, inode: 2 };

  /**
   * Rust reads and validates the archive before the frontend measures it, so a
   * path with no file at it by then has been deleted in between — not a file
   * that was never there, which is what a text open records while its own read
   * has yet to happen.
   */
  it("reports it as deleted rather than as a document being created", async () => {
    let onDisk: typeof version | null = null;
    const h = createHarness({ getTextFileVersion: async () => onDisk });

    await h.lifecycle.openFileAtPath(CONTAINER);

    expect(h.lifecycle.externalChangeState.change()).toEqual({
      filePath: CONTAINER,
      kind: "deleted"
    });

    // What was recorded is what could be seen, which was nothing. So a file
    // arriving at that path later is a new file rather than a changed version
    // of the one this document came from — which nothing here can vouch for.
    onDisk = version;
    await expect(h.lifecycle.checkForExternalChange()).resolves.toBe(true);
    expect(h.lifecycle.externalChangeState.change()?.kind).toBe("appeared");
  });
});
