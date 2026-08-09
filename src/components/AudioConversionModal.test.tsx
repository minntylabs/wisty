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
const showModal = (initial: string[], names: { recording?: string; container?: string } = {}) => {
  const [lines, setLines] = createSignal(initial);
  const [open, setOpen] = createSignal(true);
  const group = () => ({
    open: open(),
    lines: lines(),
    durationSecs: 600,
    positionSecs: 12,
    convertingAudio: true,
    recordingName: names.recording ?? "rec.opus",
    containerName: names.container ?? "rec.tsf",
    cancelling: false
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
        convertingAudio={group().convertingAudio}
        recordingName={group().recordingName}
        containerName={group().containerName}
        cancelling={group().cancelling}
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

describe("what the window says it is building", () => {
  /**
   * An import that converts nothing produces no ffmpeg output, so everything in
   * the facts list used to be empty: the window was a title, a sentence and an
   * indeterminate bar, naming no file at all — alone among the app's progress
   * windows, which all show their path.
   */
  it("names both files with no output to go on", () => {
    showModal([], { recording: "interview.wav", container: "interview.tsf" });
    const facts = document.querySelector(".conversion-facts")?.textContent ?? "";
    expect(facts).toContain("interview.wav");
    expect(facts).toContain("interview.tsf");
  });

  it("prefers its own name for the recording over ffmpeg's path", () => {
    showModal(["Input #0, ogg, from '/recordings/a.opus':"], { recording: "a.opus" });
    const facts = document.querySelector(".conversion-facts")?.textContent ?? "";
    expect(facts).toContain("a.opus");
    expect(facts).not.toContain("/recordings/");
  });
});
