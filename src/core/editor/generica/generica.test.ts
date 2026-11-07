import { describe, expect, it } from "vitest";
import { completeLine, documentContext } from "./genericaComplete";
import { jumpTarget } from "./genericaJump";
import { parsePhrases } from "./genericaPhrases";
import { emptyNames, scanBlocks } from "./genericaScan";
import { classifyLines } from "./genericaSyntax";

const PHRASES = parsePhrases(`# note
[lines]
send:
task:
[descriptions]
main settlement\tThe main one.
governor of main settlement\tWhoever governs.
[checks]
talked to <person>\tTalked.
reached <thing>\tReached.
has <number> <kind>\tHolds.
[sends]
at start, after 5 seconds
after <task>, after 30 seconds
[place at]
<distance> <direction> of <place>\tFar.
[directions]
north
south
[kinds]
tin
axe
[placeholders]
{dimension}\tThe dimension.
{name of X}\tA name.
`);

const FILE = [
  "== 001",
  "send: at start, after 5 seconds",
  "",
  "== welcome",
  "Control: Hello {dimension}.",
  "more words",
  "task: talk_to_governor",
  "-> questions",
  "",
  "== questions",
  "> Who? -> agents",
  "> Done. -> welcome",
  "",
  "== agents",
  "Control: Rogue.",
  "",
  "== talk_to_governor",
  "Talk to the governor.",
  "marker: governor of main settlement",
  "done when: talked to governor of main settlement"
];

const input = (before: string, sections: string[] = []) => ({
  before,
  explicit: false,
  phrases: PHRASES,
  names: { ...emptyNames(), tasks: ["talk_to_governor"], people: ["agent_1"] },
  sections
});

describe("scanBlocks", () => {
  it("tells conversations, sections and tasks apart", () => {
    const kinds = scanBlocks(FILE).map((b) => `${b.kind}:${b.name}:${b.conversation}`);
    expect(kinds).toEqual([
      "conversation:001:",
      "section:welcome:001",
      "section:questions:001",
      "section:agents:001",
      "task:talk_to_governor:"
    ]);
  });
});

describe("classifyLines", () => {
  const styles = classifyLines(FILE);
  it("colours each kind of line", () => {
    expect(styles[0].line).toBe("cm-gen-heading");
    expect(styles[1].line).toBe("cm-gen-send");
    expect(styles[4].line).toBe("cm-gen-control");
    expect(styles[5].line).toBe("cm-gen-control");
    expect(styles[6].line).toBe("cm-gen-taskline");
    expect(styles[7].line).toBe("cm-gen-jump");
    expect(styles[10].line).toBe("cm-gen-reply");
    expect(styles[17].line).toBe("cm-gen-tasktext");
  });
  it("marks placeholders and task names", () => {
    expect(styles[4].marks.some((m) => m.cls === "cm-gen-placeholder")).toBe(true);
    expect(styles[6].marks.find((m) => m.cls === "cm-gen-taskname")?.from).toBe(6);
    expect(styles[16].marks.some((m) => m.cls === "cm-gen-taskname")).toBe(true);
  });
});

describe("completeLine", () => {
  it("offers check phrases after done when", () => {
    const r = completeLine(input("done when: "));
    expect(r?.from).toBe(11);
    expect(r?.options.map((o) => o.insert)).toContain("talked to ");
  });
  it("offers descriptions and names for a slot", () => {
    const r = completeLine(input("done when: talked to gov"));
    expect(r?.from).toBe(21);
    const labels = r?.options.map((o) => o.label);
    expect(labels).toContain("governor of main settlement");
    expect(labels).toContain("agent_1");
  });
  it("offers kinds for the kind slot", () => {
    const r = completeLine(input("done when: has 5 "));
    expect(r?.options.map((o) => o.label)).toEqual(["tin", "axe"]);
  });
  it("offers task names", () => {
    expect(completeLine(input("task: t"))?.options.map((o) => o.label)).toEqual(["talk_to_governor"]);
  });
  it("offers sections after a jump, also on a reply line", () => {
    const r = completeLine(input("> Who? -> ag", ["agents", "welcome"]));
    expect(r?.from).toBe(10);
    expect(r?.options.map((o) => o.label)).toEqual(["agents", "welcome"]);
  });
  it("offers placeholders", () => {
    const r = completeLine(input("Control: hi {di"));
    expect(r?.from).toBe(13);
    expect(r?.options.map((o) => o.label)).toContain("dimension");
  });
  it("offers directions and places in an at line", () => {
    expect(completeLine(input("at: 2 km no"))?.options.map((o) => o.label)).toEqual(["north", "south"]);
    expect(completeLine(input("at: 2 km north of "))?.options.map((o) => o.label)).toContain("main settlement");
  });
  it("stays quiet on ordinary speech", () => {
    expect(completeLine(input("Control: Welcome to the world"))).toBeNull();
  });
});

describe("documentContext and jumpTarget", () => {
  it("lists the sections of the caret's conversation", () => {
    expect(documentContext(FILE, 10).sections).toEqual(["welcome", "questions", "agents"]);
  });
  it("finds the section a jump names", () => {
    expect(jumpTarget(FILE, 7)).toBe(9);
    expect(jumpTarget(FILE, 10)).toBe(13);
    expect(jumpTarget(FILE, 11)).toBe(3);
    expect(jumpTarget(FILE, 6)).toBe(16);
    expect(jumpTarget(FILE, 4)).toBeNull();
  });
  it("only counts a click on the name itself", () => {
    expect(jumpTarget(FILE, 10, 0)).toBeNull();
    expect(jumpTarget(FILE, 10, 13)).toBe(13);
  });
});
