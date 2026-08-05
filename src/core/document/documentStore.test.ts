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
