import { AnalysisRegistry } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";

/** Completion inside a slot that holds author-written JSON Schema.
 *
 *  These slots used to be declared `type: object` and nothing more, so
 *  navigation found no `properties` and the author got no suggestions from the
 *  first key down. They now point at the `KindSchema` / `JsonSchema7` manifest
 *  fragment, which is localized to `#/$defs/…` and hoisted into the schema AJV
 *  compiles — so this exercises the `$ref` hop, the `additionalProperties`
 *  fallback a `properties:` map needs, and the fragment's self-recursion.
 *
 *  Every fixture puts a key in the block before the cursor: an empty mapping
 *  whose only line is the cursor's own indentation resolves to the enclosing
 *  document, which is a property of the AST cursor resolver and not of the
 *  schema being navigated. */

const DEFINITION_DOC = ["kind: Telo.Definition", "metadata:", "  name: Thing"];

async function completeAt(lines: string[]): Promise<string[]> {
  const text = lines.join("\n");
  const line = lines.length - 1;
  const results = await buildCompletions(text, line, lines[line].length, new AnalysisRegistry());
  return results.map((r) => r.label);
}

describe("buildCompletions — JSON Schema slots", () => {
  it("offers JSON Schema keywords inside a kind's schema block", async () => {
    const labels = await completeAt([...DEFINITION_DOC, "schema:", "  type: object", "  "]);
    expect(labels).toEqual(
      expect.arrayContaining(["properties", "required", "additionalProperties", "description"]),
    );
  });

  it("offers the x-telo-* vocabulary inside a kind's schema, where a slot is configured", async () => {
    const labels = await completeAt([...DEFINITION_DOC, "schema:", "  type: object", "  "]);
    expect(labels).toEqual(expect.arrayContaining(["x-telo-eval", "x-telo-ref", "x-telo-type"]));
  });

  it("recurses: a property's own schema completes like the schema containing it", async () => {
    const labels = await completeAt([
      ...DEFINITION_DOC,
      "schema:",
      "  type: object",
      "  properties:",
      "    connection:",
      "      title: Connection",
      "      ",
    ]);
    // Reached through `properties`' additionalProperties and the fragment's
    // self-reference — two levels below the slot that named the fragment.
    expect(labels).toEqual(expect.arrayContaining(["type", "description", "x-telo-ref"]));
  });

  it("withholds the annotations in a data schema — a status block configures no slot", async () => {
    const labels = await completeAt([...DEFINITION_DOC, "status:", "  type: object", "  "]);
    expect(labels).toEqual(expect.arrayContaining(["properties", "description"]));
    expect(labels).not.toContain("x-telo-ref");
    expect(labels).not.toContain("x-telo-eval");
  });

  it("completes a Telo.JsonSchema resource's own schema field", async () => {
    const labels = await completeAt([
      "kind: Telo.JsonSchema",
      "metadata:",
      "  name: Order",
      "schema:",
      "  type: object",
      "  ",
    ]);
    expect(labels).toEqual(expect.arrayContaining(["properties", "required"]));
    expect(labels).not.toContain("x-telo-ref");
  });
});
