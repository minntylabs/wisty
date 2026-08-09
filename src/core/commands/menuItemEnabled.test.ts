import { describe, expect, it } from "vitest";
import { createCommandRegistry, menuItemEnabled } from "./commandRegistry";

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

describe("running a command that fails", () => {
  /**
   * Both callers discard the promise — `void execute(...)` — so a command that
   * rejected was an unhandled rejection in the console and nothing on screen.
   * Most commands report their own failures; the spelling-language ones call
   * the settings actions directly and do not.
   */
  it("reports the failure instead of rejecting", async () => {
    const failure = new Error("settings unavailable");
    const reported: [string, unknown][] = [];
    const registry = createCommandRegistry(
      [{ id: "spell.language.en", label: "English", run: async () => { throw failure; } }],
      (commandId, error) => reported.push([commandId, error])
    );

    await expect(registry.execute("spell.language.en")).resolves.toBe(false);
    expect(reported).toEqual([["spell.language.en", failure]]);
  });

  it("still answers true for a command that succeeds", async () => {
    const registry = createCommandRegistry([
      { id: "file.save", label: "Save", run: async () => {} }
    ]);
    await expect(registry.execute("file.save")).resolves.toBe(true);
  });

  it("does not need a reporter to stay safe", async () => {
    const registry = createCommandRegistry([
      { id: "file.save", label: "Save", run: async () => { throw new Error("nope"); } }
    ]);
    await expect(registry.execute("file.save")).resolves.toBe(false);
  });
});
