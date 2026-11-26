import type { ResourceContext, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { resolveApplicationInputs } from "../src/application-env.js";
import { create } from "../src/controllers/type/json-schema-controller.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { SchemaValidator } from "../src/schema-validator.js";
import { kindDeclarationOf } from "@telorun/analyzer";
import { createKindDocument } from "./create-kind-document.js";
import { demandingEvery } from "./input-demand.js";

const TAIL =
  "so validating any value against it never ends. A schema may refer back to itself only beneath 'properties', " +
  "'patternProperties', 'additionalProperties', 'items', 'additionalItems', 'prefixItems' or 'contains'.";

describe("a schema recursing in place", () => {
  it("is refused when a kind declaring it registers", () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    expect(() =>
      kernel.registerResourceDefinition({
        kind: "Telo.Definition",
        metadata: { name: "Holder", module: "Acme" },
        capability: "Telo.Provider",
        schema: { anyOf: [{ $ref: "#" }] },
      } as any),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_SCHEMA_IN_PLACE_CYCLE",
        message:
          "Telo.Definition 'Holder': its schema comes back to where it started without descending into the value — " +
          `'anyOf/0' of schema refers to schema — ${TAIL}`,
      }),
    );
  });

  it("is refused when a need type declaring it in a field registers, the field read as its own root", () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    expect(() =>
      kernel.registerResourceDefinition(
        kindDeclarationOf({
          kind: "Telo.NeedType",
          metadata: { name: "Db", module: "Acme" },
          fields: { url: { $defs: { L: { anyOf: [{ $ref: "#/$defs/L" }] } }, $ref: "#/$defs/L" } },
        } as unknown as ResourceManifest)!,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_SCHEMA_IN_PLACE_CYCLE",
        message:
          "Telo.NeedType 'Db': its schema comes back to where it started without descending into the value — " +
          `'$defs/L/anyOf/0' of fields.url refers to fields.url at '$defs/L' — ${TAIL}`,
      }),
    );
  });

  it("is refused when a named shape closing it through another registers", async () => {
    const validator = new SchemaValidator();
    validator.addSchema("telo:Acme/S2", { oneOf: [{ $ref: "telo:Acme/S1" }, { type: "integer" }] });
    const ctx = {
      lookupSchema: (name: string) => validator.getSchema(name),
      registerSchema: (name: string, schema: object) => validator.addSchema(name, schema),
      registerTypeRules: () => {},
    } as unknown as ResourceContext;
    await expect(
      create(
        {
          kind: "Telo.JsonSchema",
          metadata: { name: "S1", module: "Acme" },
          schema: { oneOf: [{ $ref: "telo:Acme/S2" }, { type: "string" }] },
        } as unknown as ResourceManifest,
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "ERR_SCHEMA_IN_PLACE_CYCLE",
      message:
        "Telo.JsonSchema 'S1': its schema comes back to where it started without descending into the value — " +
        `'oneOf/0' of S1 refers to S2, where 'oneOf/0' of S2 refers to S1 — ${TAIL}`,
    });
    expect(validator.getSchema("telo:Acme/S1")).toBeUndefined();
  });

  it("is refused in an Application's variables: entry before any input is read", async () => {
    await expect(
      resolveApplicationInputs(
        {
          kind: "Telo.Application",
          metadata: { name: "App" },
          variables: { x: { env: "X", type: "object", default: { a: 1 }, anyOf: [{ $ref: "#" }] } },
        },
        {},
        new SchemaValidator(),
        { demand: demandingEvery() },
      ),
    ).rejects.toMatchObject({
      code: "ERR_SCHEMA_IN_PLACE_CYCLE",
      message:
        "Telo.Application 'App': its schema comes back to where it started without descending into the value — " +
        `'anyOf/0' of variables.x refers to variables.x — ${TAIL}`,
    });
  });

  it("is refused when a function declaring it in its signature is created", async () => {
    expect(
      await createKindDocument({
        kind: "Telo.Function",
        metadata: { name: "twice" },
        params: [{ name: "x", schema: { anyOf: [{ $ref: "#" }, { type: "integer" }] } }],
        returns: { schema: { type: "integer" } },
        body: "x",
      }),
    ).toMatchObject({ code: "ERR_SCHEMA_IN_PLACE_CYCLE", message: expect.stringContaining("Telo.Function 'twice': its schema") });
  });
});
