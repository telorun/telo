import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import * as PageController from "../src/page-controller.js";
import { resolvedPageWidth } from "../src/page-width.js";

const ctx = {
  resolveRef: (value: unknown) => value,
  lookupSchema: () => undefined,
  createTypeValidator: () => ({ validate: () => {}, isValid: () => true }),
  expandValue: (value: unknown) => value,
} as unknown as ResourceContext;
const page = (width?: "contained" | "full") =>
  PageController.create({ kind: "Ui.Page", metadata: { name: "home" }, path: "/", title: { text: "Home" } as never, width, children: [] } as never, ctx);
const request = { headers: {} };

describe("a page's width", () => {
  it("is its own, else the one it is invoked with, else contained", async () => {
    expect((await (await page("contained")).invoke({ request, pageWidth: "full" })).width).toBe("contained");
    expect((await (await page()).invoke({ request, pageWidth: "full" })).width).toBe("full");
    expect([resolvedPageWidth(null, "full"), resolvedPageWidth("contained", "full")]).toEqual(["full", "contained"]);
    expect(resolvedPageWidth(undefined, undefined)).toBe("contained");
  });
});
