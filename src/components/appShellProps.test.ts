/**
 * Every reactive field of an AppShell props group must be a getter.
 *
 * A props group written plainly — `{ open: converting(), lines: lines() }` —
 * is rebuilt on every access, so reading any one field reads them all. Asking
 * whether a dialog is open therefore subscribes to everything the dialog
 * shows, and the dialog's contents are re-created on every update.
 *
 * That is measured, not theoretical: with the plain shape the conversion
 * window re-created its children about seven times a second — once per batch
 * of ffmpeg output — which discarded a native `<details>` element's open state
 * each time, and would equally discard scroll position, selection or focus in
 * any dialog fed this way.
 *
 * A source scan, because the fault is invisible at runtime in tests: the
 * values are correct either way, and only the number of re-creations differs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_PATH = join(__dirname, "..", "App.tsx");

/** The props groups AppShell takes, each an object literal in App's JSX. */
const GROUP_NAMES = [
  "addedWordsDialog",
  "largeFileDialog",
  "importProblems",
  "loading",
  "saving",
  "statusBar",
  "errorModal",
  "externalChange"
];

/** The text of `name={{ ... }}`, brace-matched so nested objects survive. */
const groupBody = (source: string, name: string): string | null => {
  const start = source.indexOf(`${name}={{`);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let at = source.indexOf("{", start); at < source.length; at += 1) {
    if (source[at] === "{") {
      depth += 1;
    } else if (source[at] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, at + 1);
      }
    }
  }
  return null;
};

/**
 * Fields written as `name: value`, at the group's own nesting level, whose
 * value reads a signal or a store. Handlers are values too, but a handler is
 * called rather than read, so it costs nothing to leave as a plain property.
 */
const eagerFields = (body: string): string[] => {
  const found: string[] = [];
  // Depth, not indentation. Keying on how far a line is indented meant a group
  // nested one level deeper — or simply reformatted — passed this check without
  // a single field being looked at.
  let depth = 0;
  for (const line of body.split("\n")) {
    const openedAt = depth;
    for (const character of line) {
      if (character === "{" || character === "(" || character === "[") {
        depth += 1;
      } else if (character === "}" || character === ")" || character === "]") {
        depth -= 1;
      }
    }
    // A field of the group itself: inside its braces, outside anything nested.
    if (openedAt !== 2) {
      continue;
    }
    const match = /^\s*([A-Za-z][A-Za-z0-9]*):\s*(.+?),?\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const [, field, value] = match;
    const isHandler = /^(\(|async\s|function\b)/.test(value) || /^[A-Za-z][\w.]*$/.test(value);
    const readsState = /\(\)/.test(value) || /\bstate\./.test(value);
    if (!isHandler && readsState) {
      found.push(`${field}: ${value}`);
    }
  }
  return found;
};

describe("AppShell props groups", () => {
  const source = readFileSync(APP_PATH, "utf8");

  it("passes every group", () => {
    const missing = GROUP_NAMES.filter((name) => groupBody(source, name) === null);
    expect(missing, "this list has drifted from App.tsx").toEqual([]);
  });

  it("reads each field only when it is asked for", () => {
    const eager = GROUP_NAMES.flatMap((name) => {
      const body = groupBody(source, name);
      return body ? eagerFields(body).map((field) => `${name}.${field}`) : [];
    });

    expect(eager, "write these as getters, so reading one field does not read the rest").toEqual([]);
  });
});
