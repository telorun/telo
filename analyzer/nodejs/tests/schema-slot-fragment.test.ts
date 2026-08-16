import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { KERNEL_BUILTINS } from "../src/builtins.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";
import {
  expandManifestFragments,
  manifestFragment,
  manifestFragmentOf,
  manifestFragmentRef,
  withSchemaFragments,
} from "../src/manifest-schemas.js";
import { validateAgainstSchema } from "../src/schema-compat.js";

/** The recursive half of the shared fragment set: a slot holding author-written
 *  JSON Schema.
 *
 *  Every other fragment is expanded in place, which a shape containing ITSELF
 *  cannot be. These are localized to a document-local `#/$defs/<Name>` pointer
 *  instead, with one copy hoisted to the root of the schema a validator
 *  compiles — the form both AJV and the editor's local-only `$ref` resolver can
 *  follow. */

function definitionByName(name: string): Record<string, any> {
  const def = KERNEL_BUILTINS.find((d) => (d.metadata as any)?.name === name);
  if (!def) throw new Error(`no builtin named ${name}`);
  return def as unknown as Record<string, any>;
}

describe("recursive fragment localization", () => {
  it("rewrites the reference to a document-local pointer and hoists one copy", () => {
    const schema: Record<string, any> = {
      type: "object",
      properties: {
        inputType: { title: "Input", $ref: manifestFragmentRef("JsonSchema7") },
      },
    };
    withSchemaFragments(schema);

    expect(schema.properties.inputType.$ref).toBe("#/$defs/telo:JsonSchema7");
    // Siblings survive for the human surfaces; draft-07 drops them at the
    // validation layer, which is why a slot may add a title but not narrow.
    expect(schema.properties.inputType.title).toBe("Input");
    expect(manifestFragmentOf(schema.properties.inputType)).toBe("JsonSchema7");
    expect(Object.keys(schema.$defs)).toEqual(["telo:JsonSchema7"]);
  });

  it("stamps the hoisted body too, so a nested schema node still says what it is", () => {
    const schema = withSchemaFragments({
      type: "object",
      properties: { schema: { $ref: manifestFragmentRef("KindSchema") } },
    }) as Record<string, any>;

    expect(manifestFragmentOf(schema.$defs["telo:KindSchema"])).toBe("KindSchema");
    // The fragment describes a schema, so it points at itself for the schema a
    // property holds — that self-reference is what completion follows.
    expect(
      schema.$defs["telo:KindSchema"].properties.properties.additionalProperties.$ref,
    ).toBe("#/$defs/telo:KindSchema");
  });

  it("hoists to the enclosing top-level schema key, not to the document", () => {
    const doc: Record<string, any> = {
      kind: "Telo.Definition",
      metadata: { name: "Thing" },
      schema: {
        type: "object",
        properties: { shape: { $ref: manifestFragmentRef("JsonSchema7") } },
      },
    };
    expandManifestFragments(doc);

    // `schema:` is what a validator compiles, so the pointer has to resolve
    // against IT — a `$defs` on the document would be invisible to AJV.
    expect(doc.schema.$defs["telo:JsonSchema7"]).toBeDefined();
    expect(doc.$defs).toBeUndefined();
  });

  it("refuses to be embedded, since a recursive fragment has no expanded form", () => {
    expect(() => manifestFragment("JsonSchema7")).toThrow(/recursive/);
    // The non-recursive fragments are unaffected.
    expect(manifestFragmentOf(manifestFragment("InvokeStep"))).toBe("InvokeStep");
  });
});

describe("schema slots on the built-in kinds", () => {
  it("validates a status block as JSON Schema, with the path to the bad keyword", () => {
    const definition = definitionByName("Definition");
    const doc = {
      kind: "Telo.Definition",
      metadata: { name: "Thing" },
      status: { type: "object", properties: { port: { type: "integer", minimum: "3" } } },
    };

    const issues = validateAgainstSchema(doc, definition.schema);
    expect(issues.map((i) => i.path)).toContain("status.properties.port.minimum");
  });

  it("accepts a schema block carrying x-telo-* annotations", () => {
    const definition = definitionByName("Definition");
    const doc = {
      kind: "Telo.Definition",
      metadata: { name: "Thing" },
      schema: {
        type: "object",
        properties: {
          store: { type: "object", "x-telo-ref": { kind: "KvStore.Store", use: "dependency" } },
          url: { type: "string", "x-telo-eval": "compile" },
        },
        required: ["store"],
      },
    };

    // Open by construction: the annotations are not properties of the fragment,
    // and closing it would reject the next one a module invents.
    expect(validateAgainstSchema(doc, definition.schema)).toEqual([]);
  });

  it("keeps an author's own $defs entry of the same name, which the reserved key makes possible", () => {
    const schema = withSchemaFragments({
      type: "object",
      $defs: { JsonSchema7: { type: "string" } },
      properties: { shape: { $ref: manifestFragmentRef("JsonSchema7") } },
    }) as Record<string, any>;

    // `$defs` is the author's namespace. Under an unreserved key the author's
    // shape would have silently become what every slot pointing at the fragment
    // validates against — a wrong-but-plausible result with nothing to see.
    expect(schema.$defs.JsonSchema7).toEqual({ type: "string" });
    expect(schema.properties.shape.$ref).toBe("#/$defs/telo:JsonSchema7");
    expect(manifestFragmentOf(schema.$defs["telo:JsonSchema7"])).toBe("JsonSchema7");
  });

  it("rejects a misspelled type in a Telo.JsonSchema resource", () => {
    const definition = definitionByName("JsonSchema");
    const doc = {
      kind: "Telo.JsonSchema",
      metadata: { name: "Order" },
      schema: { type: "object", properties: { total: { type: "nubmer" } } },
    };

    const issues = validateAgainstSchema(doc, definition.schema);
    expect(issues.map((i) => i.path)).toContain("schema.properties.total.type");
  });
});

/** Through `analyze()`, not through `validateAgainstSchema`.
 *
 *  The unit-level assertions above pass a document straight to the validator,
 *  which is a path the real pipeline may never reach: AJV's `addSchema`
 *  meta-validates and throws, and that throw used to escape the whole pass — so
 *  the diagnostic these tests assert existed only in the test. Anything claiming
 *  a schema slot is checked has to prove it here. */
function analyze(manifests: unknown[]) {
  return new StaticAnalyzer().analyze(withSyntheticPositions(manifests as ResourceManifest[]));
}

describe("schema slots through the analysis pass", () => {
  const badSchemaAndStatus = {
    kind: "Telo.Definition",
    metadata: { name: "Thing", module: "test" },
    capability: "Telo.Invocable",
    schema: { type: "object", properties: { name: { type: "string", minimum: "3" } } },
    status: { type: "object", properties: { port: { type: "integer", minimum: "3" } } },
  };

  it("reports both blocks, each anchored on its own keyword", () => {
    const violations = analyze([badSchemaAndStatus]).filter((d) => d.code === "SCHEMA_VIOLATION");
    const paths = violations.map((d) => (d.data as { path?: string }).path);
    expect(paths).toContain("schema.properties.name.minimum");
    expect(paths).toContain("status.properties.port.minimum");
  });

  it("survives a kind schema AJV refuses to register, instead of aborting the run", () => {
    // The abort took every other diagnostic in the file with it — including the
    // `status:` one above, which has nothing to do with the schema AJV rejected.
    const other = {
      kind: "Telo.Definition",
      metadata: { name: "Other", module: "test" },
      capability: "Telo.Invocable",
      status: { type: "object", properties: { ready: { type: "boolean", minLength: "x" } } },
    };
    const paths = analyze([badSchemaAndStatus, other])
      .filter((d) => d.code === "SCHEMA_VIOLATION")
      .map((d) => (d.data as { path?: string }).path);
    expect(paths).toContain("status.properties.ready.minLength");
  });

  it("anchors a Telo.JsonSchema resource's own schema", () => {
    const doc = {
      kind: "Telo.JsonSchema",
      metadata: { name: "Order", module: "test" },
      schema: { type: "object", properties: { total: { type: "nubmer" } } },
    };
    const paths = analyze([doc])
      .filter((d) => d.code === "SCHEMA_VIOLATION")
      .map((d) => (d.data as { path?: string }).path);
    expect(paths).toContain("schema.properties.total.type");
  });
});
