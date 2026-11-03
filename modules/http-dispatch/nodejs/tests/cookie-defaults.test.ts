import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import * as HostCookieController from "../src/host-cookie-controller.js";
import * as SecureCookieController from "../src/secure-cookie-controller.js";
import * as UnprefixedCookieController from "../src/unprefixed-cookie-controller.js";

/** The kernel validates a copy of a resource, so a schema `default:` never
 *  reaches a controller: each one restates them, and must agree. */
const documents = parseAllDocuments(
  readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"),
).map((document) => document.toJS() as { kind: string; metadata: { name: string }; schema?: any });

function schemaDefaults(name: string): Record<string, unknown> {
  const own = documents.find((document) => document.metadata?.name === name)!;
  const abstract = documents.find((document) => document.metadata?.name === "Cookie")!;
  const defaults: Record<string, unknown> = {};
  for (const schema of [abstract.schema, own.schema]) {
    for (const [key, property] of Object.entries<any>(schema.properties ?? {})) {
      if (property.default !== undefined) defaults[key] = property.default;
    }
  }
  return defaults;
}

const controllers = {
  HostCookie: HostCookieController,
  SecureCookie: SecureCookieController,
  UnprefixedCookie: UnprefixedCookieController,
};

describe("cookie controllers", () => {
  for (const [kind, controller] of Object.entries(controllers)) {
    it(`${kind} fills every schema default its kind declares`, async () => {
      const declaration = await controller.create({ name: "c" });
      const published = declaration.snapshot();
      const defaults = schemaDefaults(kind);
      expect(Object.keys(defaults).length).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(defaults)) expect(published[key]).toEqual(value);
    });
  }
});
