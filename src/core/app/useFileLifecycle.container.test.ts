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
  const markersEnabled = vi.fn((enabled: boolean) => {
    events.push(enabled ? "markers-on" : "markers-off");
  });
  const releasePlayback = vi.fn(() => {
    events.push("playback-released");
  });
  const streamReadTextFile = vi.fn(async function* () {
    yield { text: "plain text", bytesReadTotal: 10, fileSizeBytes: 10 };
  });

  const deps = {
    editor: {
      focus: () => {},
      getText: () => editorText.value,
      getDocLength: () => editorText.value.length,
      getTextSlice: (from: number, to: number) => editorText.value.slice(from, to),
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
        return { bytesWrittenTotal: savedChunks.join("").length };
      },
      finishSaveFileStream: async () => ({ bytesWrittenTotal: 1 }),
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
    showFileTooLarge: async () => {}
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
    streamReadTextFile,
    markersEnabled,
    releasePlayback,
    events
  };
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
    await Promise.resolve();
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
    await Promise.resolve();
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

    expect(h.startSaveFileStream).toHaveBeenCalledWith("/tmp/notes.txt");
    expect(h.showError).not.toHaveBeenCalled();
  });
});
