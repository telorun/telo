import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

/**
 * Dispatch inputs ride the debug wire redacted only per `x-telo-sensitive`, and
 * an object-level mark redacts the value whole, so the four members carrying the
 * raw credential must each be marked.
 */
describe("Http.CredentialRequest", () => {
  it("marks every member that carries a raw credential as sensitive", () => {
    const text = readFileSync(fileURLToPath(new URL("../../telo.yaml", import.meta.url)), "utf8");
    const doc = parseAllDocuments(text, { customTags: [] })
      .map((d) => d.toJS({ maxAliasCount: -1 }) as { metadata?: { name?: string }; schema?: any } | null)
      .find((d) => d?.metadata?.name === "CredentialRequest");
    const properties = doc?.schema?.properties ?? {};
    for (const name of ["headers", "query", "cookies", "clientCertificate"]) {
      expect(properties[name]?.["x-telo-sensitive"], name).toBe(true);
    }
  });
});
