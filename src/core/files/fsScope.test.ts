/**
 * The file-access scope, checked as configuration rather than behaviour.
 *
 * Tauri decides what the frontend may read and write from the capability file
 * and the plugin config, and the app cannot observe that decision from inside a
 * test — a refusal arrives as a rejected `invoke` at runtime. So the settings
 * that matter are asserted here, where getting one wrong fails the suite rather
 * than a user's day.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TAURI_ROOT = join(__dirname, "..", "..", "..", "src-tauri");

const config = JSON.parse(readFileSync(join(TAURI_ROOT, "tauri.conf.json"), "utf8"));
const capability = JSON.parse(
  readFileSync(join(TAURI_ROOT, "capabilities", "default.json"), "utf8")
);

describe("what the app is allowed to open", () => {
  /**
   * `requireLiteralLeadingDot` defaults to true on Unix, and with it a `**`
   * glob refuses to match any path component beginning with a dot. Since every
   * permission here is granted as `**`, that quietly forbade every file under
   * ~/.local, ~/.config or ~/.ssh, every .gitignore and .env, and everything
   * inside a .git directory — reported to the user as "forbidden path".
   *
   * The editor's whole premise is that it opens the file you point it at, and
   * the save path already reasons about "a dotfile linked into a repository"
   * as an everyday case.
   */
  it("does not treat a dot in the path as a reason to refuse", () => {
    expect(config.plugins?.fs?.requireLiteralLeadingDot).toBe(false);
  });

  it("grants each file permission over the whole filesystem", () => {
    // The scope is deliberately wide: what may be opened is the user's choice,
    // made through a file dialog or a command line, not a policy in here.
    const scoped = capability.permissions.filter(
      (permission: unknown): permission is { identifier: string; allow: { path: string }[] } =>
        typeof permission === "object" && permission !== null && "allow" in permission
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const permission of scoped) {
      expect(
        permission.allow.map((entry: { path: string }) => entry.path),
        `${permission.identifier} should reach the whole filesystem`
      ).toContain("**");
    }
  });
});
