import { describe, expect, it } from "vitest";
import { bindingEntrySchema, importEntrySchema } from "./application-adapter";
import type { ParsedImport } from "./model";
import { resolveSiblingTypedProp } from "./components/resource-schema-form/sibling-typed-field";

const S3: ParsedImport = {
  name: "S3",
  source: "oci://ghcr.io/telorun/aws/s3@0.8.1",
  importKind: "oci",
  inline: true,
};

function props(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return schema.properties as Record<string, Record<string, unknown>>;
}

describe("importEntrySchema", () => {
  it("shows the source, and never lets the form rewrite it", () => {
    // Repointing an import has to re-resolve its sub-graph; a field write would
    // rewrite the YAML and leave the workspace holding the old module's kinds.
    expect(props(importEntrySchema(S3)).source.readOnly).toBe(true);
  });

  it("offers `integrity` only where the entry wrote its pin as a sibling", () => {
    expect(props(importEntrySchema(S3)).integrity).toBeUndefined();
    const pinned = props(importEntrySchema({ ...S3, integrity: "sha256-abc" }));
    expect(pinned.integrity.readOnly).toBe(true);
  });

  it("types each block from what the library declares, closing the name set", () => {
    const p = props(
      importEntrySchema(S3, {
        variables: { bucket: { type: "string", description: "Target bucket." } },
        secrets: { accessKey: { type: "string" } },
      }),
    );

    expect(p.variables.properties).toEqual({
      bucket: { type: "string", description: "Target bucket." },
    });
    expect(p.secrets.properties).toEqual({ accessKey: { type: "string" } });
    // Closed: no value schema, so the form offers no way to invent a name the
    // library never declared.
    expect(p.variables.additionalProperties).toBeUndefined();
  });

  it("omits a block the library declares nothing for", () => {
    const p = importEntrySchema(S3, { variables: { bucket: { type: "string" } } });
    expect(Object.keys(p.properties as object)).toEqual(["source", "variables"]);
  });

  it("offers no value blocks at all for a library that accepts nothing", () => {
    expect(Object.keys(importEntrySchema(S3, {}).properties as object)).toEqual(["source"]);
  });

  it("falls back to an open name→string map when the library was not read", () => {
    const p = props(importEntrySchema(S3));
    // An unresolved import must stay editable, and its values are strings on the
    // wire. Never an open object — that renders the JSON-Schema editor.
    expect(p.variables.additionalProperties).toEqual({ type: "string" });
    expect(p.variables.properties).toBeUndefined();
    expect(p.secrets.additionalProperties).toEqual({ type: "string" });
  });
});

describe("bindingEntrySchema", () => {
  function defaultSlotFor(isApplication: boolean, entry: Record<string, unknown>) {
    const props = bindingEntrySchema(isApplication).properties as Record<
      string,
      Record<string, unknown>
    >;
    return resolveSiblingTypedProp(props.default, entry);
  }

  it("types `default` from the entry's own declared type", () => {
    expect(defaultSlotFor(true, { env: "PORT", type: "integer" })?.type).toBe("integer");
    expect(defaultSlotFor(false, { type: "string" })?.type).toBe("string");
  });

  it("offers no `default` for a type the form cannot edit as a value", () => {
    expect(defaultSlotFor(true, { env: "CFG", type: "object" })).toBeNull();
    // Nor before a type is declared — a text box there would write "8080" into
    // an entry that is about to become an integer.
    expect(defaultSlotFor(false, {})).toBeNull();
  });

  it("binds an env var only for an Application", () => {
    const app = bindingEntrySchema(true);
    expect(Object.keys(app.properties as object)).toContain("env");
    expect(app.required).toEqual(["env"]);
    // A library entry is a plain JSON-Schema declaration; libraries have no
    // host-env access, so there is nothing to bind and nothing required.
    const library = bindingEntrySchema(false);
    expect(Object.keys(library.properties as object)).not.toContain("env");
    expect(library.required).toBeUndefined();
  });
});
