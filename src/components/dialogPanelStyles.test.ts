/**
 * Every dialog panel must be positioned by the stylesheet.
 *
 * Kobalte portals a dialog's content to the end of the body and styles none of
 * it. A panel whose class only sets, say, a width therefore renders in normal
 * flow below the page — invisible, while its overlay dims the window. That is
 * not hypothetical: the audio conversion modal shipped with
 * `.conversion-panel { width: 560px }` and nothing else, so importing a
 * recording that needed converting dimmed the screen and showed no window.
 *
 * Rendering tests do not catch this — jsdom applies no stylesheet, so the panel
 * is in the document either way — which is why this reads the CSS instead.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENT_ROOT = __dirname;
const STYLESHEET_PATH = join(__dirname, "..", "App.css");

/** The `modal-panel` companion class each dialog's content carries. */
const panelClasses = (): { className: string; file: string }[] => {
  const found: { className: string; file: string }[] = [];
  for (const name of readdirSync(COMPONENT_ROOT)) {
    if (!/\.tsx$/.test(name) || /\.test\.tsx$/.test(name)) {
      continue;
    }
    const source = readFileSync(join(COMPONENT_ROOT, name), "utf8");
    for (const match of source.matchAll(/<DialogContent\s+class="([^"]*)"/g)) {
      const classes = match[1].split(/\s+/).filter((className) => className && className !== "modal-panel");
      for (const className of classes) {
        found.push({ className, file: name });
      }
    }
  }
  return found;
};

/** The declarations of the last rule for `.className`, flattened. */
const ruleBody = (stylesheet: string, className: string): string | null => {
  const rule = new RegExp(`(^|[,}])\\s*\\.${className}\\s*\\{([^}]*)\\}`, "g");
  let body: string | null = null;
  for (const match of stylesheet.matchAll(rule)) {
    body = match[2];
  }
  return body;
};

describe("dialog panel styles", () => {
  /**
   * The checks below read class names out of the source, so a class this file
   * cannot read is a panel it cannot check — and an unpositioned one would
   * ship exactly as the conversion panel did. A literal is the price of being
   * able to prove anything about them.
   */
  it("gives every dialog a class it can be checked by", () => {
    const computed: string[] = [];
    for (const name of readdirSync(COMPONENT_ROOT)) {
      if (!/\.tsx$/.test(name) || /\.test\.tsx$/.test(name)) {
        continue;
      }
      const source = readFileSync(join(COMPONENT_ROOT, name), "utf8");
      for (const match of source.matchAll(/<Dialog(?:Content|Overlay)\s+class=(.)/g)) {
        if (match[1] !== '"') {
          computed.push(`${name}: class=${match[1]}…`);
        }
      }
    }

    expect(computed, "write these as literal class strings so they can be linted").toEqual([]);
  });

  it("positions every dialog panel", () => {
    const stylesheet = readFileSync(STYLESHEET_PATH, "utf8");

    const unpositioned = panelClasses()
      .filter(({ className }) => {
        const body = ruleBody(stylesheet, className);
        return body === null || !/position:\s*fixed/.test(body);
      })
      .map(({ className, file }) => `.${className} (${file})`);

    expect(
      unpositioned,
      "these panels would render in page flow, below the overlay: give each position: fixed and a z-index"
    ).toEqual([]);
  });

  /**
   * A panel positioned above its own overlay, so the dim never covers it. The
   * overlay classes sit alongside the panel's on the same dialog.
   */
  it("puts every dialog panel above its overlay", () => {
    const stylesheet = readFileSync(STYLESHEET_PATH, "utf8");
    const layerOf = (className: string): number | null => {
      const body = ruleBody(stylesheet, className);
      const match = body ? /z-index:\s*(\d+)/.exec(body) : null;
      return match ? Number(match[1]) : null;
    };

    const wrong: string[] = [];
    for (const name of readdirSync(COMPONENT_ROOT)) {
      if (!/\.tsx$/.test(name) || /\.test\.tsx$/.test(name)) {
        continue;
      }
      const source = readFileSync(join(COMPONENT_ROOT, name), "utf8");
      const overlay = /<DialogOverlay\s+class="([^"]*)"/.exec(source);
      const content = /<DialogContent\s+class="([^"]*)"/.exec(source);
      if (!overlay || !content) {
        continue;
      }
      const layers = (classes: string) =>
        classes
          .split(/\s+/)
          .map(layerOf)
          .filter((layer): layer is number => layer !== null);
      const overlayLayer = Math.max(0, ...layers(overlay[1]));
      const panelLayer = Math.max(0, ...layers(content[1]));
      if (panelLayer <= overlayLayer) {
        wrong.push(`${name}: panel at ${panelLayer}, overlay at ${overlayLayer}`);
      }
    }

    expect(wrong, "the overlay would cover the dialog it dims for").toEqual([]);
  });
});
