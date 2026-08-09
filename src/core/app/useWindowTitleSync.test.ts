import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { formatWindowTitle, useWindowTitleSync } from "./useWindowTitleSync";

type TitleResult = { ok: true } | { ok: false; reason: string };
type TitleParams = { label: string; title: string };

const setNativeWindowTitle = vi.fn<(params: TitleParams) => Promise<TitleResult>>(
  async () => ({ ok: true })
);

vi.mock("../window/windowTitleService", () => ({
  setNativeWindowTitle: (params: { label: string; title: string }) => setNativeWindowTitle(params)
}));

beforeEach(() => {
  setNativeWindowTitle.mockReset();
  setNativeWindowTitle.mockResolvedValue({ ok: true });
});

/** Lets the effect's own promise settle. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("formatting the title", () => {
  it("marks an unsaved document with a star", () => {
    expect(formatWindowTitle("notes.txt", true)).toBe("*notes.txt");
    expect(formatWindowTitle("notes.txt", false)).toBe("notes.txt");
  });

  it("calls a document with no name Untitled", () => {
    expect(formatWindowTitle("", false)).toBe("Untitled");
  });
});

describe("keeping the window's title current", () => {
  it("sends each new title once", async () => {
    await createRoot(async (dispose) => {
      const [fileName, setFileName] = createSignal("one.txt");
      useWindowTitleSync({ fileName, isDirty: () => false });
      await settle();
      expect(setNativeWindowTitle).toHaveBeenCalledTimes(1);

      setFileName("two.txt");
      await settle();
      expect(setNativeWindowTitle).toHaveBeenCalledTimes(2);
      expect(setNativeWindowTitle).toHaveBeenLastCalledWith({ label: "main", title: "two.txt" });

      // Same title again: nothing to do.
      setFileName("two.txt");
      await settle();
      expect(setNativeWindowTitle).toHaveBeenCalledTimes(2);
      dispose();
    });
  });

  /**
   * The title was recorded as applied before the call was made, so one that
   * failed to reach the window was remembered as the one showing — and the
   * guard then skipped every later attempt at it, leaving the window under a
   * name from some earlier document.
   */
  it("tries again after a title the window refused", async () => {
    await createRoot(async (dispose) => {
      const [fileName, setFileName] = createSignal("one.txt");
      const reasons: string[] = [];
      setNativeWindowTitle.mockResolvedValueOnce({ ok: false, reason: "no such window" });

      useWindowTitleSync({ fileName, isDirty: () => false, onError: (r) => reasons.push(r) });
      await settle();
      expect(reasons).toEqual(["no such window"]);

      // Away and back to the same title: it never took, so it is not current.
      setFileName("two.txt");
      await settle();
      setFileName("one.txt");
      await settle();

      const titles = setNativeWindowTitle.mock.calls.map((call) => call[0].title);
      expect(titles).toEqual(["one.txt", "two.txt", "one.txt"]);
      dispose();
    });
  });
});
