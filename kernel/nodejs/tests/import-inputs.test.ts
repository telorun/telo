import { describe, expect, it } from "vitest";
import { isCelTimestamp } from "@telorun/sdk";
import { settleImportInputs } from "../src/controllers/module/import-inputs.js";
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
