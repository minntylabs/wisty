import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./documentStore";

describe("document kind", () => {
  it("starts as a text document", () => {
    expect(createDocumentStore().state.kind).toBe("text");
  });

  it("defaults to text, so only opening a container can set otherwise", () => {
    // Every existing caller saves or opens plain text; the safe value is the
    // one that does not stop the ordinary save path working.
    const store = createDocumentStore();
    store.setFilePath("/tmp/notes.txt");
    expect(store.state.kind).toBe("text");
  });

  it("records a container when told to", () => {
    const store = createDocumentStore();
    store.setFilePath("/archive/mum_11.tsf", "container");
    expect(store.state.kind).toBe("container");
    expect(store.state.fileName).toBe("mum_11.tsf");
  });

  it("returns to text when the document becomes something else", () => {
    const store = createDocumentStore();
    store.setFilePath("/archive/mum_11.tsf", "container");
    store.setFilePath("/tmp/notes.txt");
    expect(store.state.kind).toBe("text");
  });

  it("returns to text for a new untitled document", () => {
    const store = createDocumentStore();
    store.setFilePath("/archive/mum_11.tsf", "container");
    store.setUntitled();
    expect(store.state.kind).toBe("text");
    expect(store.state.filePath).toBe("");
  });
});

describe("recording a saved revision", () => {
  it("marks the document clean when nothing changed during the save", () => {
    const store = createDocumentStore();
    store.setRevision(4);

    store.markSavedAt(4);

    expect(store.state).toMatchObject({ baselineRevision: 4, currentRevision: 4, isDirty: false });
  });

  it("stays dirty when the document moved on while the save was in flight", () => {
    // The revision passed in is the one written to disk, not the one in the
    // editor now. Marking it clean would hide the edit made during the save.
    const store = createDocumentStore();
    store.setRevision(4);

    store.setRevision(5);
    store.markSavedAt(4);

    expect(store.state).toMatchObject({ baselineRevision: 4, currentRevision: 5, isDirty: true });
  });

  it("leaves the current revision alone, unlike markCleanAt", () => {
    // markCleanAt asserts both revisions; markSavedAt only knows what was
    // written, so moving currentRevision would lose the editor's position.
    const store = createDocumentStore();
    store.setRevision(9);

    store.markSavedAt(2);
    expect(store.state.currentRevision).toBe(9);

    store.markCleanAt(2);
    expect(store.state.currentRevision).toBe(2);
  });

  it("goes clean again once the edits made during the save are themselves saved", () => {
    const store = createDocumentStore();
    store.setRevision(4);
    store.setRevision(5);
    store.markSavedAt(4);

    store.markSavedAt(5);

    expect(store.state.isDirty).toBe(false);
  });
});
