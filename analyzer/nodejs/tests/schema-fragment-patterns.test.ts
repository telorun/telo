/**
 * The schema fragments are Telo's meta-schema: they read a pattern as `format: regex`
 * exactly where the draft-07 meta-schema does, and place a schema everywhere it does,
 * so a pattern RE2 refuses is a `SCHEMA_VIOLATION` wherever a schema is written.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAGMENTS = path.resolve(HERE, "../../../sdk/builtins/fragments");
const draft7 = createRequire(import.meta.url)("ajv/dist/refs/json-schema-draft-07.json") as Record<string, any>;

type Node = Record<string, any>;

/** Every place `root` reads a pattern (`regex@<path>`) and places a schema
 *  (`schema@<path>`), a path naming keywords from a schema node, `*` for any member
 *  or element. `self` says whether a reference names the schema itself. */
function places(root: Node, self: (ref: string) => boolean): Set<string> {
  const found = new Set<string>();
  const local = (ref: string): Node | undefined =>
    ref.startsWith("#/") ? ref.slice(2).split("/").reduce<any>((node, key) => node?.[key], root) : undefined;
  const walk = (node: unknown, at: string, seen: Set<Node>): void => {
    if (!node || typeof node !== "object") return;
    const schema = node as Node;
    if (typeof schema.$ref === "string") {
      if (self(schema.$ref)) {
        found.add(`schema@${at}`);
        return;
      }
      const target = local(schema.$ref);
      if (target && !seen.has(target)) walk(target, at, new Set([...seen, target]));
    }
    if (schema.format === "regex") found.add(`regex@${at}`);
    if (schema.propertyNames?.format === "regex") found.add(`regex@${at}/*`);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      for (const branch of (schema[key] as unknown[] | undefined) ?? []) walk(branch, at, seen);
    }
    const into = (name: string) => (at === "" ? name : `${at}/${name}`);
    for (const [name, child] of Object.entries((schema.properties as Node | undefined) ?? {})) walk(child, into(name), seen);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      walk(schema.additionalProperties, into("*"), seen);
    }
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) walk(schema.items, into("*"), seen);
  };
  walk(root, "", new Set([root]));
  return found;
}

const meta = places(draft7, (ref) => ref === "#");
const of = (prefix: string) => [...meta].filter((p) => p.startsWith(prefix));

describe.each(["JsonSchema7", "KindSchema"])("the %s fragment", (name) => {
  const fragment = JSON.parse(fs.readFileSync(path.join(FRAGMENTS, `${name}.json`), "utf8")) as Node;
  const own = places(fragment, (ref) => ref === `telo://manifest#/$defs/${name}`);

  it("reads a pattern as `format: regex` exactly where the draft-07 meta-schema does", () => {
    expect([...own].filter((p) => p.startsWith("regex@")).sort()).toEqual(of("regex@").sort());
    expect(of("regex@").sort()).toEqual(["regex@pattern", "regex@patternProperties/*"]);
  });

  it("places a schema everywhere the draft-07 meta-schema places one", () => {
    const missing = of("schema@").filter((p) => !own.has(p));
    expect(missing).toEqual([]);
    expect(of("schema@").length).toBeGreaterThan(10);
  });
});
