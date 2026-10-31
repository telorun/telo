/**
 * A whole-value chain to an input one configuration decides
 * (`!cel "variables.dialect"`, `!cel "secrets.databaseUrl.scheme"`) is, in that
 * configuration, the literal it reads — so its slot holds it to the schema as
 * that literal, the verdict a literal written there gets, in every eval mode.
 * Only what schema validation reads is replaced; the site stays a CEL site for
 * every other reader.
 *
 * Browser-safe.
 */
import { isCompiledValue } from "@telorun/sdk";
import { CEL_ENGINE, isTaggedSentinel } from "@telorun/templating";

/** `value` as one configuration's schema validation reads it: each whole-value
 *  chain `chains` decides replaced by its literal, beneath the declaration
 *  itself and no nested one. `paths` are the places replaced (`a.b[0]`). */
export function withNarrowedLiterals(
  value: Record<string, unknown>,
  chains: ReadonlyMap<string, unknown> | undefined,
): { value: Record<string, unknown>; paths: ReadonlySet<string> } {
  const paths = new Set<string>();
  if (!chains || chains.size === 0) return { value, paths };
  const walk = (node: unknown, path: string, root: boolean): unknown => {
    const source = celSource(node);
    if (source !== undefined) {
      const chain = source.trim();
      if (!chains.has(chain)) return node;
      paths.add(path);
      return chains.get(chain);
    }
    if (node === null || typeof node !== "object" || isTaggedSentinel(node) || isCompiledValue(node)) return node;
    if (Array.isArray(node)) {
      let changed = false;
      const out = node.map((item, i) => {
        const next = walk(item, `${path}[${i}]`, false);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : node;
    }
    const record = node as Record<string, unknown>;
    // A nested declaration is judged as its own resource.
    if (!root && typeof record.kind === "string") return node;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(record)) {
      if (root && (key === "kind" || key === "metadata")) {
        out[key] = field;
        continue;
      }
      const next = walk(field, path ? `${path}.${key}` : key, false);
      if (next !== field) changed = true;
      out[key] = next;
    }
    return changed ? out : node;
  };
  return { value: walk(value, "", true) as Record<string, unknown>, paths };
}

function celSource(node: unknown): string | undefined {
  if (isTaggedSentinel(node)) return node.engine === CEL_ENGINE ? node.source : undefined;
  if (isCompiledValue(node)) {
    const engine = (node as { engine?: unknown }).engine;
    return (engine === undefined || engine === CEL_ENGINE) && typeof node.source === "string" ? node.source : undefined;
  }
  return undefined;
}
