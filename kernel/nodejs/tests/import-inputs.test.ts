import { describe, expect, it } from "vitest";
import { isCelTimestamp } from "@telorun/sdk";
import { textParametersOfBlock, withSchemaFragments } from "@telorun/analyzer";
import {
  settleImportInputs,
  settleTextParameters,
  textParameterOrigins,
} from "../src/controllers/module/import-inputs.js";
import { assertSharedInputsAgree, type SharedLibrary } from "../src/controllers/module/shared-libraries.js";
import { acceptsBy } from "../src/members-values.js";
import { SchemaValidator } from "../src/schema-validator.js";

/** An import's `variables:` / `secrets:` read against the library's declared entries. */
const validator = new SchemaValidator();
const settle = (
  supplied: Record<string, unknown>,
  declared: Record<string, unknown>,
  block: "variables" | "secrets" = "variables",
) =>
  settleImportInputs(
    supplied,
    declared,
    block,
    "Lib",
    (schema) => validator.compile(schema, { persist: false }),
    acceptsBy(validator),
  );
const refusalOf = (run: () => unknown): { code?: string; message: string } => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected a refusal");
};

const postgresUrl = { "x-telo-type": { name: "Telo.Url", scheme: { enum: ["postgres", "postgresql"] } } };

describe("an import's supplied library inputs", () => {
  it("decodes an instance type's text and builds a URL, redacting its text and password", () => {
    const { values, redacted } = settle(
      { at: "2026-01-15T09:30:00Z", url: "postgres://app:imp-pw@db.internal/orders" },
      { at: { "x-telo-type": "Telo.Timestamp" }, url: postgresUrl },
    );
    expect(isCelTimestamp(values.at)).toBe(true);
    expect((values.url as { host: string }).host).toBe("db.internal");
    expect(redacted).toEqual(["postgres://app:imp-pw@db.internal/orders", "imp-pw"]);
  });

  it("refuses a URL the entry refuses under the type's own code, naming the import and the variable", () => {
    const refusal = refusalOf(() => settle({ url: "mysql://app:imp-pw@db/orders" }, { url: postgresUrl }));
    expect(refusal.code).toBe("ERR_URL_INVALID");
    expect(refusal.message).toBe(
      "Import 'Lib': variables.url is not a Telo.Url: its scheme must be one of postgres, postgresql",
    );
  });

  it("refuses any other mismatch as a schema failure naming the keyword", () => {
    const refusal = refusalOf(() => settle({ count: "x" }, { count: { type: "integer" } }));
    expect(refusal.code).toBe("ERR_RESOURCE_SCHEMA_VALIDATION_FAILED");
    expect(refusal.message).toBe("Import 'Lib': variables.count fails the library's declaration ('type'): must be integer");
  });

  it("never prints a secret's value, whichever way it fails", () => {
    for (const run of [
      () => settle({ dsn: "mysql://app:s3cr3t-pw@db/orders" }, { dsn: postgresUrl }, "secrets"),
      () => settle({ pin: "s3cr3t-pw" }, { pin: { type: "string", pattern: "^[0-9]+$" } }, "secrets"),
    ]) {
      expect(refusalOf(run).message).not.toContain("s3cr3t-pw");
    }
  });
});

/** A library declaring `title` as a text parameter, its default the library's own text. */
const textDeclared = withSchemaFragments({
  type: "object",
  properties: { title: { $ref: "telo://manifest#/$defs/Text", default: "Hello" } },
}).properties as Record<string, unknown>;
const textParams = textParametersOfBlock(textDeclared, "variables");
const compiled = { __compiled: true };
const settleTexts = (written: unknown, expanded: Record<string, unknown>) => {
  const origins = textParameterOrigins(textParams, written, expanded, "Lib");
  const supplied = { ...expanded, title: expanded.title ?? "Hello" };
  return settleTextParameters(
    supplied,
    expanded,
    textParams,
    origins,
    { importer: "pl", library: "en" },
    "Lib",
    (schema) => validator.compile(schema, { persist: false }),
  );
};

describe("an import's text parameters", () => {
  it("hands over a written text as the importer's record and the default as the library's", () => {
    expect(settleTexts({ title: "Hej" }, { title: "Hej" }).title).toEqual({
      text: "Hej",
      context: null,
      lang: "pl",
      computed: false,
    });
    expect(settleTexts({}, {}).title).toEqual({ text: "Hello", context: null, lang: "en", computed: false });
  });

  it("passes a computed record on unchanged and refuses any other computed value", () => {
    const record = { text: "Hello", context: null, lang: "de", computed: false };
    expect(settleTexts({ title: compiled }, { title: record }).title).toBe(record);
    const refusal = refusalOf(() => settleTexts({ title: compiled }, { title: "Hello" }));
    expect(refusal.code).toBe("ERR_TEXT_ARGUMENT_COMPUTED");
    expect(refusal.message).toContain("Import 'Lib': the value at 'variables.title' is computed");
  });

  it("refuses a block computed whole and an expression inside a written text", () => {
    expect(refusalOf(() => settleTexts(compiled, { title: "Hello" })).message).toContain(
      "the value at 'variables' is computed",
    );
    expect(refusalOf(() => settleTexts({ title: { text: compiled, context: "x" } }, {})).message).toContain(
      "the value at 'variables.title.text' is computed",
    );
  });
});

describe("a shared library's text parameter", () => {
  const entry = (title: unknown) =>
    ({
      owner: "First",
      module: "Shared",
      variables: { title },
      secrets: {},
      resources: new Map(),
      needs: new Map(),
      declaredVariables: textDeclared,
      declaredSecrets: {},
    }) as unknown as SharedLibrary;
  const agree = (a: unknown, b: unknown) =>
    assertSharedInputsAgree(entry(a), "Second", { title: b }, {}, new Map(), new Map());

  it("agrees on two spellings of one settled text", () => {
    expect(() =>
      agree(
        { text: "Hello", context: null, lang: "en", computed: false },
        { text: { plural: "n", cases: { other: "Hello" } }, context: null, lang: "en", computed: false },
      ),
    ).not.toThrow();
  });

  it("refuses one text written in two languages, naming both", () => {
    const refusal = refusalOf(() =>
      agree(
        { text: "Hello", context: null, lang: "en", computed: false },
        { text: "Hello", context: null, lang: "de", computed: false },
      ),
    );
    expect(refusal.code).toBe("ERR_SHARED_LIBRARY_CONFLICT");
    expect(refusal.message).toContain("variables.title (the same text written in 'en' and in 'de')");
  });
});
