import { refSentinelTarget, type AstDocument, type AstMap, type AstNode, type AstScalar } from "@telorun/analyzer";
import { isTaggedSentinel, type RefIndex } from "@telorun/templating";

import { scalarString } from "../completions/resolve-node.js";

/**
 * What the editor reads of the `!for-each` tag and of the indexed `!ref`.
 *
 * A `!ref` is read from the verdict the loader attached to its sentinel
 * (`parsed` / `refusal`), never by splitting its text; the only arithmetic on
 * the text is placing the parsed parts, whose lengths the grammar fixes (no
 * whitespace, no quoting inside the text).
 */

export const FOR_EACH_TAG = "!for-each";
/** The binding a loop declares when it writes no `as:`. */
export const DEFAULT_BINDING = "each";

export interface ForEachLoop {
  /** The loop's mapping, tag included. */
  map: AstMap;
  /** The binding it declares: its `as:`, else `each`. */
  binding: string;
  /** The span of the `as:` value, when written. */
  asRange?: [number, number];
  /** The span of the `in:` value, when written. */
  sourceRange?: [number, number];
  /** The CEL text of the `in:` value, when it is an expression. */
  source?: string;
  /** The loop declares a name (`metadata.name`): it is a family. */
  family?: { name: string; range: [number, number] };
}

function entryOf(map: AstMap, key: string): AstNode | undefined {
  return map.entries.find((pair) => scalarString(pair.key) === key)?.value;
}

/** Every `!for-each` of a document, outermost first. */
export function forEachLoops(doc: AstDocument): ForEachLoop[] {
  const out: ForEachLoop[] = [];
  const visit = (node: AstNode | undefined): void => {
    if (!node) return;
    if (node.kind === "map") {
      if (node.tag === FOR_EACH_TAG) {
        const as = entryOf(node, "as");
        const source = entryOf(node, "in");
        const metadata = entryOf(node, "metadata");
        const named = metadata?.kind === "map" ? entryOf(metadata, "name") : undefined;
        const binding = as?.kind === "scalar" ? scalarString(as) : undefined;
        const name = named?.kind === "scalar" ? scalarString(named) : undefined;
        out.push({
          map: node,
          binding: binding ?? DEFAULT_BINDING,
          ...(as?.kind === "scalar" && binding ? { asRange: as.range } : {}),
          ...(source ? { sourceRange: source.range } : {}),
          ...(source?.kind === "scalar" && isTaggedSentinel(source.value) ? { source: source.value.source } : {}),
          ...(named && name ? { family: { name, range: named.range } } : {}),
        });
      }
      for (const pair of node.entries) visit(pair.value);
    } else if (node.kind === "seq") {
      for (const item of node.items) visit(item);
    }
  };
  visit(doc.root);
  return out;
}

const within = (outer: [number, number], offset: number): boolean => offset >= outer[0] && offset <= outer[1];

/** The innermost loop declaring `binding` around `offset`. */
export function loopBinding(loops: readonly ForEachLoop[], binding: string, offset: number): ForEachLoop | undefined {
  return loops
    .filter((loop) => loop.binding === binding && within(loop.map.range, offset))
    .sort((a, b) => b.map.range[0] - a.map.range[0])[0];
}

/** A `!ref` scalar as the engine's verdict reads it, with where its parts sit. */
export interface RefReading {
  alias?: string;
  name: string;
  indexes: readonly RefIndex[];
  /** The span of the name — the head, a family's included. */
  head: [number, number];
  /** The span of each index's binding, in written order. */
  bindings: [number, number][];
}

/** The reading of a `!ref` scalar; undefined for anything else and for a text
 *  the grammar refuses. `text` is the document the scalar's offsets measure. */
export function readRefScalar(scalar: AstScalar, text: string): RefReading | undefined {
  if (scalar.tag !== "!ref") return undefined;
  const target = refSentinelTarget(scalar.value);
  if (!target) return undefined;
  const quoted = text[scalar.range[0]] === '"' || text[scalar.range[0]] === "'";
  const start = scalar.range[0] + (quoted ? 1 : 0);
  const headStart = start + (target.alias !== undefined ? target.alias.length + 1 : 0);
  let at = headStart + target.name.length;
  const bindings: [number, number][] = [];
  for (const index of target.indexes) {
    bindings.push([at + 1, at + 1 + index.binding.length]);
    at += index.binding.length + index.member.length + 3;
  }
  return {
    ...(target.alias !== undefined ? { alias: target.alias } : {}),
    name: target.name,
    indexes: target.indexes,
    head: [headStart, headStart + target.name.length],
    bindings,
  };
}
