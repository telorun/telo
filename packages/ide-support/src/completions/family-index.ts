import {
  buildLineOffsets,
  iteratesFamilySource,
  offsetToPosition,
  type AstDocument,
  type AstNode,
  type LoopView,
} from "@telorun/analyzer";

import { forEachLoops, type ForEachLoop } from "../repeats/for-each.js";
import type { CompletionResult } from "../types.js";
import { resolveNodeAtPosition, scalarString } from "./resolve-node.js";

/**
 * Completion inside the brackets of a family reference (`!ref stores[` /
 * `!ref stores[each.`): the bindings of the loops around the reference that
 * iterate the family's own source at that depth, and after the dot the member
 * that source keys its elements by.
 *
 * The text being typed has no verdict — the engine has refused it or not read
 * it yet — so the prefix is the one thing read as text, and only up to the
 * cursor. Which loop iterates "the same source" is decided on the sources as
 * written (`self.names`), the way the loops are written side by side.
 */
const TYPING = /^["']?([A-Za-z_]\w*)((?:\[[A-Za-z_]\w*\.(?:key|index)\])*)\[(?:([A-Za-z_]\w*)(\.(\w*))?)?$/;

export function familyIndexCompletions(
  text: string,
  line: number,
  character: number,
  docs: AstDocument[],
): CompletionResult[] | undefined {
  const resolved = resolveNodeAtPosition(text, docs, line, character);
  const scalar = resolved?.node;
  if (!resolved || resolved.slot !== "value" || scalar?.kind !== "scalar" || scalar.tag !== "!ref") return undefined;
  const typing = TYPING.exec(resolved.prefix ?? "");
  if (!typing) return undefined;
  const [, head, done, typedBinding, dot, typedMember] = typing as unknown as [string, string, string, string?, string?, string?];

  const doc = docs[resolved.docIndex]!;
  const loops = forEachLoops(doc);
  const family = loops.find((l) => l.family?.name === head);
  if (!family) return [];

  // The loops a family at depth d is declared in: those around it, then it.
  const depth = done === "" ? 0 : done.split("]").length - 1;
  const chain = [...loops.filter((l) => l !== family && contains(l.map.range, family.map.range)), family];
  // Each level below the family is the loop its `emit:` writes.
  for (let cur = family; ; ) {
    const next = loops
      .filter((l) => l !== cur && contains(cur.map.range, l.map.range))
      .sort((a, b) => b.map.range[1] - b.map.range[0] - (a.map.range[1] - a.map.range[0]))[0];
    if (!next) break;
    chain.push(next);
    cur = next;
  }
  chain.sort((a, b) => a.map.range[0] - b.map.range[0]);
  const own = chain[depth];
  if (!own) return [];
  const source = sourceText(text, own);

  // The analyzer's rule decides which loop may index the family at this depth.
  const views = new Map<ForEachLoop, LoopView>();
  const viewOf = (loop: ForEachLoop): LoopView => {
    let view = views.get(loop);
    if (!view) {
      view = {
        binding: loop.binding,
        source: loop.source,
        get enclosing() {
          return loops
            .filter((o) => o !== loop && contains(o.map.range, loop.map.range))
            .sort((a, b) => a.map.range[0] - b.map.range[0])
            .map(viewOf);
        },
      };
      views.set(loop, view);
    }
    return view;
  };
  const around = loops
    .filter((l) => l !== family && contains(l.map.range, [resolved.offset, resolved.offset]))
    .sort((a, b) => a.map.range[0] - b.map.range[0]);
  // The binding each index already written chose, innermost loop of that name.
  const chosen = [...done.matchAll(/\[([A-Za-z_]\w*)\./g)].map((m) =>
    [...around].reverse().find((l) => l.binding === m[1]),
  );
  const matching = around.filter((l) =>
    iteratesFamilySource(depth, viewOf(l), chosen[depth - 1] ? viewOf(chosen[depth - 1]!) : undefined, viewOf(own)),
  );
  const offsets = buildLineOffsets(text);
  const at = (offset: number) => offsetToPosition(offset, offsets);

  if (dot !== undefined) {
    const members = membersOf(doc, source);
    const start = resolved.offset - (typedMember ?? "").length;
    return members.map((member) => ({
      label: member,
      kind: "enumMember" as const,
      detail: `${member === "key" ? "a map" : "a list"} source's ${member}`,
      replaceRange: { start: at(start), end: at(resolved.offset) },
    }));
  }

  const start = resolved.offset - (typedBinding ?? "").length;
  return matching.map((loop) => ({
    label: loop.binding,
    insertText: `${loop.binding}.`,
    retrigger: true,
    kind: "value" as const,
    detail: `iterates ${source}`,
    replaceRange: { start: at(start), end: at(resolved.offset) },
  }));
}

const contains = (outer: readonly [number, number], inner: readonly [number, number]): boolean =>
  inner[0] >= outer[0] && inner[1] <= outer[1];

/** The `in:` of a loop as written, without its tag. */
function sourceText(text: string, loop: ForEachLoop): string {
  return loop.sourceRange ? text.slice(loop.sourceRange[0], loop.sourceRange[1]).replace(/^["']|["']$/g, "") : "";
}

/** The member a source keys its elements by: `index` for a list, `key` for a
 *  map, read off the `type` the definition's own schema gives `self.<field>`;
 *  both when the source is anything else. */
function membersOf(doc: AstDocument, source: string): string[] {
  const field = /^self\.(\w+)$/.exec(source)?.[1];
  const type = field ? schemaTypeOf(doc.root, field) : undefined;
  if (type === "array") return ["index"];
  if (type === "object") return ["key"];
  return ["key", "index"];
}

function entry(node: AstNode | undefined, key: string): AstNode | undefined {
  return node?.kind === "map" ? node.entries.find((pair) => scalarString(pair.key) === key)?.value : undefined;
}

function schemaTypeOf(root: AstNode | undefined, field: string): string | undefined {
  return scalarString(entry(entry(entry(root, "schema"), "properties"), field) && entry(entry(entry(entry(root, "schema"), "properties"), field), "type"));
}
