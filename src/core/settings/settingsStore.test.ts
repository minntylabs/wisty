import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsStore } from "./settingsStore";
import { DEFAULT_SETTINGS, MAX_REMEMBERED_POSITIONS } from "./settingsTypes";

const backing = new Map<string, unknown>();

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: vi.fn(async () => ({
      get: vi.fn(async (key: string) => backing.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        backing.set(key, value);
      }),
      save: vi.fn(async () => {})
    }))
  }
}));

beforeEach(() => {
  backing.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
});

describe("createSettingsStore load", () => {
  it("falls back to defaults when nothing has been persisted", async () => {
    const store = createSettingsStore();
    await store.load();
    expect(store.state.formatViewMode).toBe(DEFAULT_SETTINGS.formatViewMode);
    expect(store.state.activeLineHighlightEnabled).toBe(DEFAULT_SETTINGS.activeLineHighlightEnabled);
    expect(store.state.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(store.ready()).toBe(true);
  });

  it("rejects an invalid persisted formatViewMode and falls back to the default", async () => {
    backing.set("formatViewMode", "not-a-real-mode");
    const store = createSettingsStore();
    await store.load();
    expect(store.state.formatViewMode).toBe(DEFAULT_SETTINGS.formatViewMode);
  });

  it("loads a valid persisted formatViewMode", async () => {
    backing.set("formatViewMode", "formatted");
    const store = createSettingsStore();
    await store.load();
    expect(store.state.formatViewMode).toBe("formatted");
  });

  it("rejects a non-boolean persisted activeLineHighlightEnabled", async () => {
    backing.set("activeLineHighlightEnabled", "yes");
    const store = createSettingsStore();
    await store.load();
    expect(store.state.activeLineHighlightEnabled).toBe(DEFAULT_SETTINGS.activeLineHighlightEnabled);
  });

  it("loads a valid persisted activeLineHighlightEnabled", async () => {
    backing.set("activeLineHighlightEnabled", true);
    const store = createSettingsStore();
    await store.load();
    expect(store.state.activeLineHighlightEnabled).toBe(true);
  });

  it("clamps an out-of-range persisted fontSize", async () => {
    backing.set("fontSize", 999);
    const store = createSettingsStore();
    await store.load();
    expect(store.state.fontSize).toBe(40);
  });
});

describe("createSettingsStore actions", () => {
  it("setFormatViewMode updates state and persists", async () => {
    const store = createSettingsStore();
    await store.load();
    await store.actions.setFormatViewMode("formatted");
    expect(store.state.formatViewMode).toBe("formatted");
    expect(backing.get("formatViewMode")).toBe("formatted");
  });

  it("setActiveLineHighlightEnabled updates state and persists", async () => {
    const store = createSettingsStore();
    await store.load();
    await store.actions.setActiveLineHighlightEnabled(true);
    expect(store.state.activeLineHighlightEnabled).toBe(true);
    expect(backing.get("activeLineHighlightEnabled")).toBe(true);
  });

  it("does not persist changes before load() has completed", async () => {
    const store = createSettingsStore();
    await store.actions.setActiveLineHighlightEnabled(true);
    expect(store.state.activeLineHighlightEnabled).toBe(true);
    expect(backing.has("activeLineHighlightEnabled")).toBe(false);
  });
});

describe("remembered positions", () => {
  const POSITION = { topLine: 40, cursorLine: 42, cursorColumn: 7 };

  const loadedStore = async () => {
    const store = createSettingsStore();
    await store.load();
    return store;
  };

  it("defaults to none remembered", async () => {
    const store = await loadedStore();
    expect(store.state.rememberedPositions).toEqual({});
  });

  it("rememberPosition stores under the file path and persists", async () => {
    const store = await loadedStore();
    await store.actions.rememberPosition("/tmp/a.txt", POSITION);
    expect(store.state.rememberedPositions["/tmp/a.txt"]).toEqual(POSITION);
    expect(backing.get("rememberedPositions")).toEqual({ "/tmp/a.txt": POSITION });
  });

  it("ignores an empty file path, since there is nothing to key by", async () => {
    const store = await loadedStore();
    await store.actions.rememberPosition("", POSITION);
    expect(store.state.rememberedPositions).toEqual({});
  });

  it("forgetPosition removes the entry, which is what turns restoring off", async () => {
    const store = await loadedStore();
    await store.actions.rememberPosition("/tmp/a.txt", POSITION);
    await store.actions.forgetPosition("/tmp/a.txt");
    expect(store.state.rememberedPositions).toEqual({});
    expect(backing.get("rememberedPositions")).toEqual({});
  });

  it("moveRememberedPosition follows a document to its new path", async () => {
    const store = await loadedStore();
    await store.actions.rememberPosition("/tmp/a.txt", POSITION);
    await store.actions.moveRememberedPosition("/tmp/a.txt", "/tmp/b.txt");
    expect(store.state.rememberedPositions).toEqual({ "/tmp/b.txt": POSITION });
  });

  it("moveRememberedPosition does nothing when the old path had no entry", async () => {
    const store = await loadedStore();
    await store.actions.moveRememberedPosition("/tmp/a.txt", "/tmp/b.txt");
    expect(store.state.rememberedPositions).toEqual({});
  });

  it("evicts the least recently touched entry once over the cap", async () => {
    const store = await loadedStore();
    for (let index = 0; index < MAX_REMEMBERED_POSITIONS + 5; index++) {
      await store.actions.rememberPosition(`/tmp/file-${index}.txt`, POSITION);
    }
    const paths = Object.keys(store.state.rememberedPositions);
    expect(paths).toHaveLength(MAX_REMEMBERED_POSITIONS);
    expect(paths).not.toContain("/tmp/file-0.txt");
    expect(paths).toContain(`/tmp/file-${MAX_REMEMBERED_POSITIONS + 4}.txt`);
  });

  it("re-storing a path refreshes its recency rather than duplicating it", async () => {
    const store = await loadedStore();
    await store.actions.rememberPosition("/tmp/a.txt", POSITION);
    await store.actions.rememberPosition("/tmp/b.txt", POSITION);
    await store.actions.rememberPosition("/tmp/a.txt", { ...POSITION, topLine: 1 });
    expect(Object.keys(store.state.rememberedPositions)).toEqual(["/tmp/b.txt", "/tmp/a.txt"]);
    expect(store.state.rememberedPositions["/tmp/a.txt"].topLine).toBe(1);
  });

  it("discards malformed persisted entries but keeps the valid ones", async () => {
    backing.set("rememberedPositions", {
      "/tmp/good.txt": POSITION,
      "/tmp/partial.txt": { topLine: 3 },
      "/tmp/wrong-type.txt": { topLine: "3", cursorLine: 1, cursorColumn: 0 },
      "/tmp/negative.txt": { topLine: -1, cursorLine: 1, cursorColumn: 0 },
      "/tmp/null.txt": null
    });
    const store = await loadedStore();
    expect(store.state.rememberedPositions).toEqual({ "/tmp/good.txt": POSITION });
  });

  it("falls back to none when the persisted value is not an object", async () => {
    backing.set("rememberedPositions", ["nonsense"]);
    const store = await loadedStore();
    expect(store.state.rememberedPositions).toEqual({});
  });
});
