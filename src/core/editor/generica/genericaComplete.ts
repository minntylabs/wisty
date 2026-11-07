/**
 * Auto-complete for Generica. `completeLine` is pure: given the text of the
 * line before the caret it says where the completion starts and what to offer.
 * `genericaCompletion` wraps it for the editor.
 */

import { autocompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { blockAt, mergeNames, namesOf, scanBlocks, type Names } from "./genericaScan";
import { phrasesIn, type Phrases } from "./genericaPhrases";

export type Offer = {
  label: string;
  detail?: string;
  info?: string;
  /** Text to insert instead of the label. */
  insert?: string;
  /** Carry on straight away with the next part of the phrase. */
  more?: boolean;
  type?: string;
};

export type LineCompletion = { from: number; options: Offer[] };

export type CompleteInput = {
  /** The line's text up to the caret. */
  before: string;
  explicit: boolean;
  phrases: Phrases;
  names: Names;
  /** Sections of the conversation the caret is in. */
  sections: string[];
};

const KEY_LINE = /^\s*(send|task|marker|done when|fails when|is|called|kind|placed|at|within):[ \t]*(.*)$/;
const SLOT = /<[^<>]*>/g;

const offersFor = (names: string[], type: string): Offer[] => names.map((label) => ({ label, type }));

const entities = (phrases: Phrases, names: Names): Offer[] => [
  ...phrasesIn(phrases, "descriptions").map((p) => ({ label: p.text, info: p.info, type: "constant" })),
  ...offersFor([...names.people, ...names.items, ...names.places], "variable")
];

const literalPrefix = (template: string): string => {
  const at = template.indexOf("<");
  return at < 0 ? template : template.slice(0, at);
};

/** Completes `rest` (the text after `marker:` and so on) against phrase templates. */
const templateComplete = (
  rest: string,
  templates: string[],
  infos: Map<string, string>,
  input: CompleteInput,
  base: number
): LineCompletion | null => {
  const slotOffers = (slot: string): Offer[] => {
    switch (slot) {
      case "<kind>":
        return phrasesIn(input.phrases, "kinds").map((p) => ({ label: p.text, type: "enum" }));
      case "<direction>":
        return phrasesIn(input.phrases, "directions").map((p) => ({ label: p.text, type: "enum" }));
      case "<number>":
      case "<distance>":
        return [];
      case "<task>":
        return offersFor([...input.names.tasks, ...input.names.conversations], "variable");
      default:
        return entities(input.phrases, input.names);
    }
  };

  // Partway through a phrase: offer what fits the slot the caret is in.
  for (const template of templates) {
    const literals = template.split(SLOT);
    const slots = template.match(SLOT) ?? [];
    if (slots.length === 0 || literals[0] === "" || !rest.startsWith(literals[0])) {
      continue;
    }
    let pos = literals[0].length;
    for (let i = 0; i < slots.length; i++) {
      const next = literals[i + 1];
      const at = next === "" ? -1 : rest.indexOf(next, pos);
      if (at < 0) {
        const options = slotOffers(slots[i]);
        return options.length > 0 ? { from: base + pos, options } : null;
      }
      pos = at + next.length;
    }
  }

  // Specials for the place patterns, which begin with a slot.
  const after = /\bof\s+([^\s].*|)$/.exec(rest);
  if (after && /^\s*\d/.test(rest)) {
    return { from: base + rest.length - after[1].length, options: entities(input.phrases, input.names) };
  }
  const direction = /^\s*\d+\s*k?m\s+([\w-]*)$/.exec(rest);
  if (direction) {
    return { from: base + rest.length - direction[1].length, options: slotOffers("<direction>") };
  }

  const options: Offer[] = [];
  for (const template of templates) {
    const prefix = literalPrefix(template);
    if (prefix === "") {
      continue;
    }
    const hasSlot = prefix !== template;
    options.push({
      label: template,
      info: infos.get(template),
      insert: prefix,
      more: hasSlot,
      type: "keyword"
    });
  }
  if (templates.some((t) => literalPrefix(t) === "")) {
    options.push(...entities(input.phrases, input.names));
  }
  return { from: base, options };
};

export const completeLine = (input: CompleteInput): LineCompletion | null => {
  const { before, phrases, names } = input;

  const brace = /\{([^{}]*)$/.exec(before);
  if (brace) {
    const typed = brace[1];
    if (/^name of /i.test(typed)) {
      const from = before.length - (typed.length - "name of ".length);
      return { from, options: entities(phrases, names).map((o) => ({ ...o, insert: `${o.label}}` })) };
    }
    const options: Offer[] = [];
    for (const p of phrasesIn(phrases, "placeholders")) {
      const open = p.text.startsWith("{name of");
      options.push({
        label: p.text.replace(/^\{|\}$/g, ""),
        info: p.info,
        insert: open ? "name of " : `${p.text.slice(1)}`,
        more: open,
        type: "variable"
      });
    }
    return { from: before.length - typed.length, options };
  }

  const jump = /->[ \t]*([a-z0-9_]*)$/.exec(before);
  if (jump) {
    return { from: before.length - jump[1].length, options: offersFor(input.sections, "variable") };
  }

  const key = KEY_LINE.exec(before);
  if (key) {
    const word = key[1];
    const rest = key[2];
    const base = before.length - rest.length;
    const section = (name: string) => phrasesIn(phrases, name);
    const templatesOf = (name: string) => {
      const list = section(name);
      return { templates: list.map((p) => p.text), infos: new Map(list.map((p) => [p.text, p.info])) };
    };
    switch (word) {
      case "task":
        return { from: base, options: offersFor(names.tasks, "variable") };
      case "kind":
        return { from: base, options: section("kinds").map((p) => ({ label: p.text, type: "enum" })) };
      case "marker":
        return { from: base, options: entities(phrases, names) };
      case "done when":
      case "fails when": {
        const { templates, infos } = templatesOf("checks");
        return templateComplete(rest, templates, infos, input, base);
      }
      case "send": {
        const afterWord = /^after\s+([a-z0-9_]*)$/.exec(rest);
        if (afterWord) {
          return {
            from: before.length - afterWord[1].length,
            options: offersFor([...names.tasks, ...names.conversations], "variable")
          };
        }
        const { templates, infos } = templatesOf("sends");
        return templateComplete(rest, templates, infos, input, base);
      }
      case "is": {
        const { templates, infos } = templatesOf("person is");
        return templateComplete(rest, templates, infos, input, base);
      }
      case "placed": {
        const { templates, infos } = templatesOf("item placed");
        return templateComplete(rest, templates, infos, input, base);
      }
      case "at": {
        const { templates, infos } = templatesOf("place at");
        return templateComplete(rest, templates, infos, input, base);
      }
      default:
        return null;
    }
  }

  // Line words (`marker:`, `Control:` ...) only when asked for with Ctrl-Space.
  const word = /^[ \t]*([A-Za-z ]*)$/.exec(before);
  if (word && input.explicit) {
    const options: Offer[] = [
      ...phrasesIn(phrases, "lines").map((p) => ({ label: p.text, type: "keyword" })),
      ...phrasesIn(phrases, "speakers").map((p) => ({ label: `${p.text}:`, type: "keyword" }))
    ];
    return { from: before.length - word[1].length, options };
  }
  return null;
};

/** What the editor's document says about names and sections, at a line. */
export const documentContext = (lines: readonly string[], line: number): { names: Names; sections: string[] } => {
  const blocks = scanBlocks(lines);
  const here = blockAt(blocks, line);
  let conversation = here?.kind === "conversation" ? here.name : here?.conversation ?? "";
  if (conversation === "") {
    conversation = [...blocks].reverse().find((b) => b.heading <= line && b.kind === "conversation")?.name ?? "";
  }
  const sections = blocks.filter((b) => b.kind === "section" && b.conversation === conversation).map((b) => b.name);
  return { names: namesOf(blocks), sections };
};

export type CompletionSources = {
  getPhrases: () => Phrases;
  /** Names declared in the other files of the story folder. */
  getOtherNames: () => Names;
};

export const genericaCompletion = (sources: CompletionSources): Extension =>
  autocompletion({
    override: [
      (context: CompletionContext): CompletionResult | null => {
        const line = context.state.doc.lineAt(context.pos);
        const before = line.text.slice(0, context.pos - line.from);
        const lines: string[] = [];
        for (let n = 1; n <= context.state.doc.lines; n++) {
          lines.push(context.state.doc.line(n).text);
        }
        const here = documentContext(lines, line.number - 1);
        const found = completeLine({
          before,
          explicit: context.explicit,
          phrases: sources.getPhrases(),
          names: mergeNames(here.names, sources.getOtherNames()),
          sections: here.sections
        });
        if (!found || found.options.length === 0) {
          return null;
        }
        const options: Completion[] = found.options.map((o) => ({
          label: o.label,
          detail: o.detail,
          info: o.info || undefined,
          type: o.type,
          apply: (view, _completion, from, to) => {
            const text = o.insert ?? o.label;
            view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
            if (o.more) {
              startCompletion(view);
            }
          }
        }));
        return { from: line.from + found.from, options };
      }
    ],
    activateOnTyping: true
  });
