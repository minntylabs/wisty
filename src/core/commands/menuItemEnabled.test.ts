import { describe, expect, it } from "vitest";
import { menuItemEnabled } from "./commandRegistry";

describe("whether a menu item is offered", () => {
  it("offers a command with nothing to say about itself", () => {
    expect(menuItemEnabled({}, false)).toBe(true);
  });

  it("respects what the command says about itself", () => {
    expect(menuItemEnabled({ enabled: () => false }, false)).toBe(false);
  });

  /**
   * The pipeline refuses every command while the app is busy. An item that
   * still looks ready is one that does nothing when clicked, which is how a
   * blocked app looks broken rather than busy.
   */
  it("offers nothing while the app is blocked", () => {
    expect(menuItemEnabled({}, true)).toBe(false);
    expect(menuItemEnabled({ enabled: () => true }, true)).toBe(false);
  });
});
