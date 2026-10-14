import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createProductDirectory, validateProducts } from "../app/telo-products.server.ts";

const ACCOUNTS = "https://accounts.example";

function product(id, overrides = {}) {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    url: `https://${id}.example/`,
    icon: `${ACCOUNTS}/v1/products/${id}.0123456789abcdef.svg`,
    color: { light: "oklch(0.52 0.18 295)", dark: "oklch(0.74 0.13 295)" },
    ...overrides,
  };
}

describe("validateProducts", () => {
  test("keeps valid entries in order and drops each invalid one with its reason", () => {
    const { products, rejected } = validateProducts(
      {
        products: [
          product("cloud"),
          product("bad-colour", { color: { light: "red", dark: "oklch(0.74 0.13 295)" } }),
          product("hub"),
          product("foreign", { icon: "https://evil.example/v1/products/x.svg" }),
          product("plain", { url: "http://plain.example/" }),
          product("Upper"),
          product("hub"),
          product("nameless", { name: "" }),
          product("studio"),
        ],
      },
      ACCOUNTS,
    );
    assert.deepEqual(
      products.map((p) => p.id),
      ["cloud", "hub", "studio"],
    );
    assert.deepEqual(rejected, [
      'entry 1 ("bad-colour"): color.light is not an oklch colour',
      'entry 3 ("foreign"): icon is not on the accounts origin',
      'entry 4 ("plain"): url is not https',
      'entry 5 ("Upper"): id does not match the product id pattern',
      'entry 6 ("hub"): id is listed twice',
      'entry 7 ("nameless"): name is not 1-100 characters',
    ]);
  });

  test("a colour that would close the CSS rule is refused", () => {
    const { products } = validateProducts(
      { products: [product("cloud", { color: { light: "oklch(0.5 0.1 1)}*{x:y", dark: "oklch(0.5 0.1 1)" } })] },
      ACCOUNTS,
    );
    assert.deepEqual(products, []);
  });

  test("a body that is not { products: [...] } is a failure", () => {
    for (const body of [null, [], {}, { products: {} }, "products"]) {
      assert.throws(() => validateProducts(body, ACCOUNTS), /not \{ products: \[\.\.\.\] \}/);
    }
  });
});

/** A directory over a scripted `fetch` and a clock the test moves. */
function directory(answers) {
  const calls = [];
  const logs = [];
  const clock = { now: 0 };
  const products = createProductDirectory({
    accountsOrigin: ACCOUNTS,
    now: () => clock.now,
    log: (message) => logs.push(message),
    fetch: async (url, init) => {
      calls.push({ url, signal: init.signal });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    },
  });
  return { products, calls, logs, clock };
}

describe("createProductDirectory", () => {
  test("serves one fetch for five minutes, then refreshes", async () => {
    const { products, calls, clock } = directory([
      { body: { products: [product("cloud")] } },
      { body: { products: [product("hub")] } },
    ]);
    assert.deepEqual((await products.list()).map((p) => p.id), ["cloud"]);
    assert.equal(calls[0].url, `${ACCOUNTS}/v1/products`);
    assert.ok(calls[0].signal instanceof AbortSignal);

    clock.now = 5 * 60_000 - 1;
    await products.list();
    assert.equal(calls.length, 1);

    clock.now = 5 * 60_000;
    // The caller holding a list is answered with it while the refresh runs.
    assert.deepEqual((await products.list()).map((p) => p.id), ["cloud"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await products.list()).map((p) => p.id), ["hub"]);
    assert.equal(calls.length, 2);
  });

  test("a failed refresh keeps the last good list and is logged once", async () => {
    const { products, logs, clock } = directory([
      { body: { products: [product("cloud")] } },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    await products.list();
    clock.now = 10 * 60_000;
    await products.list();
    await new Promise((resolve) => setImmediate(resolve));
    await products.list();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await products.list()).map((p) => p.id), ["cloud"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /keeping the last list.*accounts answered 503/);
  });

  test("with no list ever fetched, a failure is no list", async () => {
    const { products, logs } = directory([new Error("connect ECONNREFUSED")]);
    assert.equal(await products.list(), null);
    assert.match(logs[0], /no switcher until it answers.*ECONNREFUSED/);
  });

  test("a response of the wrong shape is a failure, not an empty list", async () => {
    const { products } = directory([{ body: [product("cloud")] }]);
    assert.equal(await products.list(), null);
  });

  test("concurrent callers share one request", async () => {
    const { products, calls } = directory([{ body: { products: [product("cloud")] } }]);
    const [a, b] = await Promise.all([products.list(), products.list()]);
    assert.equal(calls.length, 1);
    assert.deepEqual(a, b);
  });

  test("dropped entries are logged once until they change", async () => {
    const bad = product("bad", { icon: "https://evil.example/bad.svg" });
    const { products, logs, clock } = directory([
      { body: { products: [product("cloud"), bad] } },
      { body: { products: [product("cloud"), bad] } },
    ]);
    await products.list();
    clock.now = 5 * 60_000;
    await products.list();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /entry 1 \("bad"\): icon is not on the accounts origin/);
  });
});
