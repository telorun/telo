import type { ResourceContext } from "@telorun/sdk";
import { PageController, resolvedPageWidth } from "@telorun/ui";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const app = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), { logLevel: "silent" })
  .map((doc) => doc.toJS())
  .find((doc) => doc?.kind === "Telo.Definition" && doc.metadata?.name === "App");

const ctx = {
  resolveRef: (value: unknown) => value,
  lookupSchema: () => undefined,
  createTypeValidator: () => ({ validate: () => {}, isValid: () => true }),
  expandValue: (value: unknown) => value,
} as unknown as ResourceContext;

describe("the application's widths", () => {
  it("are documented as what ui fills when nothing is written, for a page invoked with none and for the header", async () => {
    const page = await PageController.create({ kind: "Ui.Page", metadata: { name: "home" }, path: "/", title: { text: "Home" }, children: [] } as never, ctx);
    expect((await page.invoke({ request: { headers: {} } })).width).toBe(app.schema.properties.pageWidth.default);
    expect(resolvedPageWidth(undefined, undefined)).toBe(app.schema.properties.pageWidth.default);
  });
});
