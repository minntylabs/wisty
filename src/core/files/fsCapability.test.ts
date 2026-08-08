/**
 * Every filesystem command the frontend calls must be granted by the app's
 * capability file.
 *
 * Tauri refuses a plugin command the capability does not permit, and it refuses
 * it at runtime, in the built app, only. Nothing else here would notice: the
 * unit tests mock `@tauri-apps/plugin-fs` wholesale, so an ungranted call
 * succeeds against the mock and the suite stays green. That is not
 * hypothetical — external-change detection called `exists` for a release
 * without `fs:allow-exists`, which would have left deletion detection silently
 * dead in the built app while every test passed.
 *
 * This is a source scan, so it catches the fault it is aimed at — a new call
 * with no matching permission — and not a permission whose path scope is too
 * narrow for the file being reached.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(__dirname, "..", "..");
const CAPABILITY_PATH = join(__dirname, "..", "..", "..", "src-tauri", "capabilities", "default.json");
/**
 * Written by the Rust build, and gitignored. Present on any machine that has
 * built the app, absent on a fresh checkout — so it is used to check this
 * file's own table against the plugin, never as the table itself.
 */
const MANIFEST_PATH = join(__dirname, "..", "..", "..", "src-tauri", "gen", "schemas", "acl-manifests.json");

/** The plugin command behind each `@tauri-apps/plugin-fs` export Wisty imports. */
const COMMAND_FOR_IMPORT: Record<string, string> = {
  exists: "fs:exists",
  open: "fs:open",
  readTextFile: "fs:read_text_file",
  stat: "fs:stat",
  writeTextFile: "fs:write_text_file"
};

/**
 * Commands reached through a value rather than an import, which no scan of the
 * source can see. `open` returns a file handle, and the streaming reader drives
 * it: `handle.read` is an fs command, and `handle.close` is the core resource
 * table's, not the plugin's. Maintained by hand — add to it when the streaming
 * reader starts using another method of the handle.
 */
const COMMANDS_USED_THROUGH_HANDLES = ["fs:read", "core:resources:close"];

/**
 * What each permission the capability grants allows, as `plugin:command`.
 *
 * Copied from the plugin's own permission files. `manifest matches` below
 * checks it against the generated ACL manifest whenever one is present, so a
 * plugin upgrade that changes a set cannot quietly invalidate it.
 */
const COMMANDS_FOR_PERMISSION: Record<string, string[]> = {
  "fs:allow-read-file": ["fs:read_file"],
  "fs:allow-write-file": ["fs:write_file", "fs:open", "fs:write"],
  "fs:allow-stat": ["fs:stat"],
  "fs:allow-exists": ["fs:exists"],
  "fs:allow-open": ["fs:open"],
  "fs:read-all": [
    "fs:read_dir",
    "fs:read_file",
    "fs:read",
    "fs:open",
    "fs:read_text_file",
    "fs:read_text_file_lines",
    "fs:read_text_file_lines_next",
    "fs:seek",
    "fs:stat",
    "fs:lstat",
    "fs:fstat",
    "fs:exists",
    "fs:watch",
    "fs:unwatch"
  ],
  "fs:write-all": [
    "fs:mkdir",
    "fs:create",
    "fs:copy_file",
    "fs:remove",
    "fs:rename",
    "fs:truncate",
    "fs:ftruncate",
    "fs:write",
    "fs:write_file",
    "fs:write_text_file"
  ],
  // Pulls in core:resources:default, which is what closes a file handle.
  "core:default": ["core:resources:close"]
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

/** The names imported from `@tauri-apps/plugin-fs`, aliases resolved to the export. */
const importedFsApis = (): { api: string; file: string }[] => {
  const imports: { api: string; file: string }[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, "utf8");
    const match = /import\s*\{([^}]*)\}\s*from\s*["']@tauri-apps\/plugin-fs["']/.exec(source);
    if (!match) {
      continue;
    }
    for (const clause of match[1].split(",")) {
      const name = clause.trim().split(/\s+as\s+/)[0].trim();
      if (name) {
        imports.push({ api: name, file });
      }
    }
  }
  return imports;
};

const grantedIdentifiers = (): string[] => {
  const capability = JSON.parse(readFileSync(CAPABILITY_PATH, "utf8")) as {
    permissions: (string | { identifier: string })[];
  };
  return capability.permissions.map((permission) =>
    typeof permission === "string" ? permission : permission.identifier
  );
};

describe("filesystem capability", () => {
  it("grants every command the frontend calls", () => {
    const granted = grantedIdentifiers();
    const allowed = new Set(granted.flatMap((identifier) => COMMANDS_FOR_PERMISSION[identifier] ?? []));

    const required = [
      ...importedFsApis().map(({ api }) => COMMAND_FOR_IMPORT[api]),
      ...COMMANDS_USED_THROUGH_HANDLES
    ];

    const missing = [...new Set(required)].filter((command) => !allowed.has(command));
    expect(missing, `add the permission for ${missing.join(", ")} to src-tauri/capabilities/default.json`)
      .toEqual([]);
  });

  /**
   * The check above can only see commands it knows the names of, so an import
   * this file has never heard of has to fail loudly rather than pass silently.
   */
  it("knows the command behind every filesystem import", () => {
    const unknown = importedFsApis()
      .filter(({ api }) => !COMMAND_FOR_IMPORT[api])
      .map(({ api, file }) => `${api} (${file})`);

    expect(unknown, "add these to COMMAND_FOR_IMPORT with the plugin command each calls").toEqual([]);
  });

  /**
   * Every filesystem permission the capability grants has to be one this file
   * models, so widening the capability cannot outrun the check above. Other
   * plugins' permissions — dialog, store, clipboard — are not this test's
   * business; `core:default` is modelled only for the one command file handles
   * need from it.
   */
  it("knows what every filesystem permission granted allows", () => {
    const unmodelled = grantedIdentifiers()
      .filter((identifier) => identifier.startsWith("fs:"))
      .filter((identifier) => !COMMANDS_FOR_PERMISSION[identifier]);
    expect(unmodelled, "add these to COMMANDS_FOR_PERMISSION").toEqual([]);
  });

  it("agrees with the generated manifest about what each permission allows", () => {
    let manifest: Record<string, { permissions: Record<string, { commands: { allow: string[] } }> }>;
    try {
      manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    } catch {
      // No Rust build here, so there is nothing to check this against. The
      // table stands on its own; this test only catches it drifting.
      return;
    }

    for (const [identifier, expected] of Object.entries(COMMANDS_FOR_PERMISSION)) {
      const [plugin, permission] = [identifier.slice(0, identifier.indexOf(":")), identifier.slice(identifier.indexOf(":") + 1)];
      const commands = manifest[plugin]?.permissions?.[permission]?.commands?.allow;
      if (!commands) {
        // Permission sets that resolve to other permissions rather than to
        // commands directly, such as core:default, are recorded here for the
        // one command Wisty needs from them and are not compared.
        continue;
      }
      expect([...expected].sort(), `${identifier} allows different commands than this file records`)
        .toEqual(commands.map((command) => `${plugin}:${command}`).sort());
    }
  });
});
