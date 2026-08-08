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
  /** What the open dialog returns. Defaults to the container. */
  dialogPath?: string;
  fileSize?: number;
  confirmOpenLargeFile?: () => Promise<boolean>;
};

const createHarness = (overrides: HarnessOverrides = {}) => {
  const document = createDocumentStore();
  const editorText = { value: "" };
  /** Ordered log of the calls whose relative order matters. */
  const events: string[] = [];
  const showError = vi.fn(async () => {});
  const openContainer = vi.fn(async () => ({
    transcript: overrides.containerText ?? TRANSCRIPT,
    meta: { tsf_version: 1, audio: { file: "audio.m4a", duration: 1709.61 } },
    audioBytes: 10_780_099
  }));
  const closeContainer = vi.fn(async () => {});
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
      getRevision: () => 1
    },
    document,
    settings: {
      state: { lastDirectory: "", recentFiles: [] },
      actions: {
        setLastDirectory: async () => {},
        addRecentFile: async () => {},
        removeRecentFile: async () => {}
      }
    },
    fileDialogs: {
      openTextFilePath: async () => ({
        kind: "opened" as const,
        filePath: overrides.dialogPath ?? CONTAINER
      }),
      saveTextFilePathAs: async () => ({ kind: "saved" as const, filePath: "/tmp/other.txt" })
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
      closeContainer
    },
    launchFileStream: {
      startLaunchFileStream: async (filePath: string) => ({ streamId: "l", filePath, fileSizeBytes: 10 }),
      readLaunchFileChunk: async () => ({ kind: "eof" as const, bytesReadTotal: 0, fileSizeBytes: 0 }),
      cancelLaunchFileStream: async () => {},
      closeLaunchFileStream: async () => {}
    },
    saveFileStream: {
      startSaveFileStream,
      writeSaveFileChunk: async () => ({ bytesWrittenTotal: 1 }),
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
    showError,
    openContainer,
    closeContainer,
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
      "markers-off",
      "playback-released",
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

    const released = h.events.indexOf("playback-released");
    expect(released).toBeGreaterThanOrEqual(0);
    expect(h.releasePlayback.mock.invocationCallOrder[0]).toBeLessThan(
      h.closeContainer.mock.invocationCallOrder[0]
    );
  });
});

describe("saving a container is refused, not attempted", () => {
  it("does not write the document text over the archive", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);

    await h.lifecycle.saveFile();

    expect(h.startSaveFileStream).not.toHaveBeenCalled();
    expect(h.showError).toHaveBeenCalled();
  });

  it("refuses Save As too", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);

    await h.lifecycle.saveFileAs();

    expect(h.startSaveFileStream).not.toHaveBeenCalled();
    expect(h.showError).toHaveBeenCalled();
  });

  it("says why, naming the file", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    await h.lifecycle.saveFile();

    const call = h.showError.mock.calls[0] as unknown as [string, unknown];
    expect(JSON.stringify(call[1])).toContain("mum_11.tsf");
  });

  it("leaves the document dirty rather than pretending it saved", async () => {
    const h = createHarness();
    await h.lifecycle.openFileAtPath(CONTAINER);
    h.document.setRevision(9);
    expect(h.document.state.isDirty).toBe(true);

    await h.lifecycle.saveFile();
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
