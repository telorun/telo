import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProducts, productColorRules, validateProducts } from "../product-list";

const ACCOUNTS = "https://accounts.example.com";

function product(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    url: `https://${id}.example.com`,
    icon: `${ACCOUNTS}/v1/products/${id}.0123456789abcdef.svg`,
    color: { light: "oklch(0.53 0.1 175)", dark: "oklch(0.74 0.12 175)" },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("validateProducts", () => {
  it("keeps valid entries in the order accounts lists them", () => {
    const list = validateProducts({ products: [product("hub"), product("cloud")] }, ACCOUNTS);
    expect(list?.map((p) => p.id)).toEqual(["hub", "cloud"]);
  });

  it.each([
    ["an entry that is not an object", "nope"],
    ["an id outside the pattern", product("Cloud")],
    ["an empty name", product("cloud", { name: "" })],
    ["a name over 100 characters", product("cloud", { name: "x".repeat(101) })],
    ["a url that is not https", product("cloud", { url: "http://cloud.example.com" })],
    ["an icon that is not https", product("cloud", { icon: "http://accounts.example.com/x.svg" })],
    [
      "an icon on another origin",
      product("cloud", { icon: "https://elsewhere.example.com/v1/products/cloud.0123456789abcdef.svg" }),
    ],
    ["no colours", product("cloud", { color: undefined })],
    [
      "a light colour outside the pattern",
      product("cloud", { color: { light: "red;}body{x:y", dark: "oklch(0.74 0.12 175)" } }),
    ],
    [
      "a dark colour outside the pattern",
      product("cloud", { color: { light: "oklch(0.53 0.1 175)", dark: "oklch(1.5 0.1 175)" } }),
    ],
  ])("drops %s and keeps the rest", (_, bad) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const list = validateProducts({ products: [product("hub"), bad, product("studio")] }, ACCOUNTS);
    expect(list?.map((p) => p.id)).toEqual(["hub", "studio"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([[null], [[]], [{}], [{ products: {} }]])("treats %j as a failure", (body) => {
    expect(validateProducts(body, ACCOUNTS)).toBeNull();
  });
});

describe("fetchProducts", () => {
  it("reads the list from accounts without credentials", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ products: [product("cloud")] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const list = await fetchProducts(ACCOUNTS, fetchMock);
    expect(list?.map((p) => p.id)).toEqual(["cloud"]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${ACCOUNTS}/v1/products`,
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it.each([
    ["a refused request", async () => new Response("", { status: 503 })],
    ["a network failure", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a body that is not JSON", async () => new Response("<html>", { status: 200 })],
    ["a body of another shape", async () => new Response('{"items":[]}', { status: 200 })],
  ])("answers null on %s", async (_, answer) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await fetchProducts(ACCOUNTS, vi.fn(answer))).toBeNull();
  });
});

describe("productColorRules", () => {
  it("writes each colour for the light and the dark mode, and colours the name by it", () => {
    const rules = productColorRules(
      validateProducts(
        {
          products: [
            product("cloud"),
            product("hub", { color: { light: "oklch(0.52 0.18 295)", dark: "oklch(0.74 0.13 295)" } }),
          ],
        },
        ACCOUNTS,
      )!,
    );
    expect(rules).toBe(
      ":root{--product-cloud:oklch(0.53 0.1 175);--product-hub:oklch(0.52 0.18 295);}" +
        ".dark{--product-cloud:oklch(0.74 0.12 175);--product-hub:oklch(0.74 0.13 295);}" +
        ".telo-product-cloud{color:var(--product-cloud);}.telo-product-hub{color:var(--product-hub);}",
    );
  });
});
