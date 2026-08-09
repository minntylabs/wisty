import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { AudioConversionModal } from "./AudioConversionModal";

let dispose: (() => void) | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  host?.remove();
  host = null;
});

/**
 * Rendered the way the app renders it: through a props object the parent
 * rebuilds from every signal on each access, so reading `open` also reads the
 * output. Passing the signals straight in would hide exactly the coupling
 * these tests are about.
 */
const showModal = (initial: string[]) => {
  const [lines, setLines] = createSignal(initial);
  const [open, setOpen] = createSignal(true);
  const group = () => ({
    open: open(),
    lines: lines(),
    durationSecs: 600,
    positionSecs: 12
  });

  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <AudioConversionModal
        open={group().open}
        lines={group().lines}
        durationSecs={group().durationSecs}
        positionSecs={group().positionSecs}
        onCancel={() => {}}
      />
    ),
    host
  );
  return { setLines, setOpen };
};

const disclosure = () => document.querySelector(".conversion-disclosure") as HTMLButtonElement;
const output = () => document.querySelector(".conversion-log");

describe("the conversion window", () => {
  /**
   * The output arrives in batches every 150ms while the window is up. Anything
   * that closes the disclosure as a batch lands takes the output away before
   * it can be read, which is the same as not having it.
   */
  it("keeps ffmpeg's output showing once it has been asked for", async () => {
    const { setLines } = showModal(["Input #0, ogg, from 'rec.opus':"]);

    disclosure().click();
    expect(output()).not.toBeNull();

    setLines(["Input #0, ogg, from 'rec.opus':", "Stream mapping:"]);
    await Promise.resolve();

    expect(output(), "the output was taken away as more of it arrived").not.toBeNull();
    expect(output()?.textContent).toContain("Stream mapping:");
  });

  it("summarises rather than showing the output until asked", () => {
    showModal(["Input #0, ogg, from 'rec.opus':"]);
    expect(output()).toBeNull();
    expect(document.querySelector(".conversion-facts")?.textContent).toContain("rec.opus");
  });

  it("hides the output again when asked", () => {
    showModal(["Stream mapping:"]);
    disclosure().click();
    disclosure().click();
    expect(output()).toBeNull();
  });

  /** What the last conversion needed explaining says nothing about the next. */
  it("starts the next conversion summarised", async () => {
    const { setOpen } = showModal(["Stream mapping:"]);
    disclosure().click();

    setOpen(false);
    await Promise.resolve();
    setOpen(true);
    await Promise.resolve();

    expect(output()).toBeNull();
  });
});
