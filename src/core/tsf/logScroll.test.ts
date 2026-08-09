import { describe, expect, it } from "vitest";
import { isPinnedToBottom } from "./logScroll";

describe("following a log", () => {
  it("follows while the view is at the end", () => {
    expect(isPinnedToBottom({ scrollTop: 780, scrollHeight: 1000, clientHeight: 220 })).toBe(true);
  });

  it("stops following once the reader has scrolled up", () => {
    expect(isPinnedToBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 220 })).toBe(false);
  });

  /**
   * A line half-scrolled into view leaves a few pixels between the view and the
   * bottom. Treating that as having scrolled away would stop following for
   * someone who never touched the scrollbar.
   */
  it("allows a few pixels of slack at the end", () => {
    expect(isPinnedToBottom({ scrollTop: 770, scrollHeight: 1000, clientHeight: 220 })).toBe(true);
  });

  it("follows a log too short to scroll", () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 220 })).toBe(true);
  });
});
