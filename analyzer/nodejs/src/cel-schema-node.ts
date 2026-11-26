import type { CelEnvironment, SchemaDependency } from "@telorun/cel";
import { schemaAtPointer } from "./schema-at-pointer.js";
import { writtenReferences } from "./schema-in-place-cycle.js";

type Schema = Record<string, any>;

/**
 * The schema node a verdict or a result names — `pointer` within the document
 * the engine read it from, which is one the analyzer handed over or its
 * resolver answered — or undefined where the pointer names no node.
 */
export function schemaNodeOf(located: SchemaDependency | undefined): Schema | undefined {
  if (!located) return undefined;
  let current: unknown = located.document;
  if (located.pointer !== "") {
    for (const raw of located.pointer.slice(1).split("/")) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current !== null && typeof current === "object" && !Array.isArray(current)
    ? (current as Schema)
    : undefined;
}

/**
 * What a value read from the located node forwards: the node itself, or —
 * where it writes a `#…` reference into the document it sits in — the node
 * read where it sits there (`schemaAtPointer`), so the reference still names
 * that document's node once the schema is held on its own.
 */
export function forwardedSchemaOf(located: SchemaDependency | undefined): Schema | undefined {
  const node = schemaNodeOf(located);
  if (!node || Object.keys(node).length === 0) return undefined;
  if (located!.pointer === "" || !writtenReferences(node).some(({ ref }) => ref === "#" || ref.startsWith("#/"))) return node;
  const keys = located!.pointer.slice(1).split("/").map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~"));
  return schemaAtPointer(located!.document as Schema, keys);
}

/**
 * The node the plain chain `chain` is read from in `env`: the one the engine
 * names for its result, when it reads the chain without a refusal and the node
 * says something — a value whose declared shape a slot or a parameter is then
 * compared with. A union of members read together is located nowhere, and so
 * forwards no shape.
 */
export function chainSchemaIn(env: CelEnvironment, chain: string): Schema | undefined {
  const located = chainLocationIn(env, chain);
  const node = schemaNodeOf(located);
  return node && Object.keys(node).length > 0 ? node : undefined;
}

/** {@link chainSchemaIn} as a forward carries it: {@link forwardedSchemaOf}. */
export function chainForwardIn(env: CelEnvironment, chain: string): Schema | undefined {
  return forwardedSchemaOf(chainLocationIn(env, chain));
}

/** Where the engine reads the plain chain `chain`'s result from in `env`. */
function chainLocationIn(env: CelEnvironment, chain: string): SchemaDependency | undefined {
  const parsed = env.parse(chain);
  if (parsed.diagnostics.length > 0) return undefined;
  const checked = env.check(parsed, { schemaNodes: true });
  if (!checked.valid) return undefined;
  const origins = checked.resultOrigins ?? [];
  return origins.length === 1 ? origins[0]!.schemaNode : undefined;
}
