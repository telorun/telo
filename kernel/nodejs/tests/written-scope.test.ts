import { canonicalTypeSchemaId } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { recordDeclarationScope } from "../src/declaration-scope.js";
import { ResourceContextImpl } from "../src/resource-context.js";
import { SchemaValidator } from "../src/schema-validator.js";

/** `ctx.lookupSchema` reads a bare type name as the asking resource's module's
 *  shape, whatever another module registered under the same name. */
const own = { type: "object", properties: { id: { type: "integer" } } };
const foreign = { type: "object", properties: { id: { type: "string" } } };

function context(shapes: Record<string, object>, registered: Record<string, object>): ResourceContextImpl {
  const validator = new SchemaValidator();
  for (const [name, schema] of Object.entries(registered)) validator.addSchema(name, schema);
  return new ResourceContextImpl(
    {} as never,
    { analysisView: { shapeLookup: (id: string) => shapes[id] } } as never,
    { name: "items", module: "App" },
    validator,
  );
}

describe("ctx.lookupSchema with a bare name", () => {
  it("answers the asking module's shape over another module's of the same name", () => {
    const ctx = context({ [canonicalTypeSchemaId("App", "Item")]: own }, { Item: foreign });
    expect(ctx.lookupSchema("Item")).toEqual(own);
  });

  it("answers from the registry when the module declares no shape of that name", () => {
    expect(context({}, { Item: foreign }).lookupSchema("Item")).toEqual(foreign);
  });
});

/** `ctx.resolveDeclaredManifest` with a holder reads a name where the holder's
 *  module wrote it, never in the asking resource's scope. */
describe("ctx.resolveDeclaredManifest with a holder", () => {
  const declared = (name: string) => ({ kind: "Std.Thing", metadata: { name } }) as never;
  const scope = (names: Record<string, unknown>) => ({
    resolveDeclaredManifest: (name: string, alias?: string) => names[alias ? `${alias}.${name}` : name],
  });

  it("resolves in the scope that declared the holder, and refuses a holder it did not hand out", () => {
    const holder = declared("posts");
    const target = declared("authors");
    recordDeclarationScope(holder, scope({ "Authors.authors": target }) as never);
    const owner = scope({ posts: holder });
    const ctx = new ResourceContextImpl(
      {} as never,
      {} as never,
      { name: "source", module: "App" },
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      "",
      owner as never,
    );
    expect(ctx.resolveDeclaredManifest("authors", "Authors")).toBeUndefined();
    expect(ctx.resolveDeclaredManifest("authors", "Authors", holder)).toBe(target);
    expect(() => ctx.resolveDeclaredManifest("authors", "Authors", declared("copy"))).toThrow(
      expect.objectContaining({ code: "ERR_REF_UNRESOLVED" }),
    );
  });
});
