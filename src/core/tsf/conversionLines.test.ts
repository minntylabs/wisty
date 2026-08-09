import { describe, expect, it } from "vitest";
import { appendConversionLines } from "./conversionLines";

const lines = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, at) => `line ${from + at}`);

describe("keeping ffmpeg's output bounded", () => {
  it("keeps everything a normal conversion says", () => {
    expect(appendConversionLines(["one"], ["two", "three"])).toEqual(["one", "two", "three"]);
  });

  it("keeps the header, which is where the summary is read from", () => {
    const kept = appendConversionLines([], lines(0, 2000));
    expect(kept.slice(0, 3)).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("keeps the end, which is what explains a failure", () => {
    const kept = appendConversionLines([], lines(0, 2000));
    expect(kept[kept.length - 1]).toBe("line 1999");
  });

  it("stops growing", () => {
    let kept: string[] = [];
    for (let batch = 0; batch < 50; batch += 1) {
      kept = appendConversionLines(kept, lines(batch * 100, batch * 100 + 100));
    }
    expect(kept.length).toBeLessThanOrEqual(301);
  });

  it("says how much is missing rather than hiding it", () => {
    const kept = appendConversionLines([], lines(0, 500));
    const marker = kept.find((line) => line.includes("not shown"));
    expect(marker).toBe("… 200 earlier lines not shown …");
  });

  /** Two roundings of the same loss must not read as twice the loss. */
  it("counts what is missing once, however many batches it took", () => {
    let kept = appendConversionLines([], lines(0, 400));
    kept = appendConversionLines(kept, lines(400, 500));
    expect(kept.filter((line) => line.includes("not shown"))).toEqual([
      "… 200 earlier lines not shown …"
    ]);
  });
});
