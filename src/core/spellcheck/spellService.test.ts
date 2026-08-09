import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSpellService } from "./spellService";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

beforeEach(() => {
  invoke.mockReset();
});

/** Answers every word as correctly spelled, and records what it was asked. */
const answerAllCorrect = () => {
  const asked: string[][] = [];
  invoke.mockImplementation(async (command: string, args: { words?: string[] }) => {
    if (command === "spell_check_words") {
      asked.push(args.words ?? []);
      return (args.words ?? []).map(() => true);
    }
    return undefined;
  });
  return asked;
};

describe("caching what has already been checked", () => {
  it("asks about each word once", async () => {
    const asked = answerAllCorrect();
    const service = createSpellService();

    await service.findMisspelled(["alpha", "beta"]);
    await service.findMisspelled(["beta", "gamma"]);

    expect(asked).toEqual([["alpha", "beta"], ["gamma"]]);
  });

  it("reports the misspelled subset in the order asked", async () => {
    invoke.mockImplementation(async (_command: string, args: { words?: string[] }) =>
      (args.words ?? []).map((word) => word !== "teh")
    );
    const service = createSpellService();

    const misspelled = await service.findMisspelled(["the", "teh", "the"]);

    expect([...misspelled]).toEqual(["teh"]);
  });

  /**
   * The cache is there to keep the words around the viewport from crossing the
   * IPC boundary repeatedly. Unbounded it gained an entry for every distinct
   * word of every document opened, for the life of the process — the one thing
   * here that scales with the gigabyte files this editor is built to open.
   */
  it("does not grow without limit", async () => {
    answerAllCorrect();
    const service = createSpellService();

    const words = Array.from({ length: 60_000 }, (_, index) => `word${index}`);
    await service.findMisspelled(words);

    // The oldest have been evicted, so asking again costs another round trip.
    const asked = answerAllCorrect();
    await service.findMisspelled(["word0"]);
    expect(asked).toEqual([["word0"]]);
  });

  it("keeps what has been looked at most recently", async () => {
    answerAllCorrect();
    const service = createSpellService();
    await service.findMisspelled(Array.from({ length: 60_000 }, (_, i) => `word${i}`));

    const asked = answerAllCorrect();
    await service.findMisspelled(["word59999"]);
    expect(asked, "the newest word was evicted").toEqual([]);
  });

  it("forgets everything when the dictionary changes", async () => {
    answerAllCorrect();
    const service = createSpellService();
    await service.findMisspelled(["alpha"]);

    const asked = answerAllCorrect();
    await service.loadDictionary("en_GB");
    await service.findMisspelled(["alpha"]);

    expect(asked).toEqual([["alpha"]]);
  });
});
