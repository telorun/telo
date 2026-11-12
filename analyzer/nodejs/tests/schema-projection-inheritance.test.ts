import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { listRequests } from "../src/declaration-requests.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { projectionScopeOf, resolveSchemaProjections, type ProjectionFailure } from "../src/schema-projection.js";
import { validateSchemaProjection } from "../src/validate-schema-projection.js";

/**
 * A kind's projection is inherited along merge-form `extends` and answered by
 * the registry's effective kind: the nearest document declaring either form
 * wins, read against the child's effective schema; a `base:` child's surface is
 * its own.
 */

const fieldsOf = (map: Record<string, unknown>) => ({
  type: "object",
  properties: {
    fields: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { type: { type: "string", enum: Object.keys(map), "x-telo-schema-map": map } },
      },
    },
  },
});

const form = {
  kind: "Telo.Definition",
  metadata: { name: "Form", module: "fx" },
  capability: "Telo.Invocable",
  "x-telo-schema-projection": { entries: "/fields", key: "type" },
  schema: fieldsOf({ text: { type: "string" }, count: { type: "integer" } }),
};

const child = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: "Telo.Definition",
  metadata: { name, module: "fx" },
  extends: "fx.Form",
  ...extra,
});

const contract = { type: "object", properties: { values: { "x-telo-schema-projection-from": "" } } };

function project(definitions: Record<string, unknown>[], kind: string) {
  const defs = new DefinitionRegistry();
  for (const definition of definitions) defs.register(definition as unknown as ResourceDefinition);
  const instance = { kind, metadata: { name: "signup", module: "app" }, fields: { age: { type: "count" } } };
  const failures: ProjectionFailure[] = [];
  const scope = projectionScopeOf(listRequests([instance] as any), (k) => defs.resolve(k), {
    moduleForAlias: () => undefined,
    referenceSlots: () => undefined,
    effectiveKind: (definition) => defs.effectiveKindOf(definition as unknown as ResourceDefinition),
  });
  const schema = resolveSchemaProjections(contract, instance, scope, failures) as Record<string, any>;
  return { values: schema.properties.values, failures: failures.map((f) => f.reason) };
}

describe("an inherited projection", () => {
  it("types an empty merge-form child's instance as its parent's", () => {
    expect(project([form, child("Signup")], "fx.Signup")).toEqual(project([form], "fx.Form"));
    expect(project([form], "fx.Form")).toMatchObject({ values: { properties: { age: { type: "integer" } } }, failures: [] });
  });

  it("stops at a base: child, whose surface is its own", () => {
    const fixed = child("Fixed", { schema: fieldsOf({ count: { type: "integer" } }), base: { fields: {} } });
    expect(project([form, fixed], "fx.Fixed").failures).toEqual(["no-projection"]);
  });

  it("reads a child redeclaring the key field through the child's own map", () => {
    const wide = child("Wide", { schema: fieldsOf({ count: { type: "number" } }) });
    expect(project([form, wide], "fx.Wide").values).toMatchObject({
      properties: { age: { type: "number" } },
    });
  });

  it("lets a child declare a derivation over an inherited projection", () => {
    const misplaced = {
      ...form,
      "x-telo-schema-projection": undefined,
      schema: { ...form.schema, "x-telo-schema-projection": form["x-telo-schema-projection"] },
    };
    const derived = child("Derived", { "x-telo-schema-projection-from": { from: "/source" } });
    expect(validateSchemaProjection(derived as never)).toEqual([]);
    expect(project([misplaced, derived], "fx.Derived").failures).not.toContain("invalid");
  });
});
