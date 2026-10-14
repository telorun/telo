import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  closedPortOrigin,
  get,
  sendJson,
  startHubWeb,
  startStubAccounts,
  startStubHub,
} from "./harness.mjs";

const CLIENT_ID = "telo-hub-web";
const TRIGGER = '<span class="sr-only">Telo products</span>';

let hub;
let accounts;
let web;
let accountsDown;

function product(id, name, light, dark, overrides = {}) {
  return {
    id,
    name,
    url: `https://${id}.example/`,
    icon: `${accounts.origin}/v1/products/${id}.0123456789abcdef.svg`,
    color: { light, dark },
    ...overrides,
  };
}

before(async () => {
  hub = await startStubHub();
  accounts = await startStubAccounts();
  accounts.handle = (req, res, url) => {
    if (url.pathname !== "/v1/products") return sendJson(res, 404, {});
    sendJson(res, 200, {
      products: [
        product("cloud", "Cloud", "oklch(0.53 0.1 175)", "oklch(0.74 0.12 175)"),
        product("hub", "Hub", "oklch(0.52 0.18 295)", "oklch(0.74 0.13 295)"),
        product("marketplace", "Marketplace", "oklch(0.56 0.15 47)", "oklch(0.75 0.14 47)", {
          icon: "https://evil.example/v1/products/marketplace.svg",
        }),
        product("studio", "Studio", "oklch(0.52 0.18 260)", "red"),
      ],
    });
  };
  web = await startHubWeb({
    hubOrigin: hub.origin,
    env: {
      OIDC_ISSUER: accounts.origin,
      OIDC_CLIENT_ID: CLIENT_ID,
      NODE_EXTRA_CA_CERTS: accounts.caFile,
    },
  });
  accountsDown = await startHubWeb({
    hubOrigin: hub.origin,
    env: {
      OIDC_ISSUER: (await closedPortOrigin()).replace("http:", "https:"),
      OIDC_CLIENT_ID: CLIENT_ID,
    },
  });
});

after(async () => {
  await web?.stop();
  await accountsDown?.stop();
  await accounts?.close();
  await hub?.close();
});

describe("product switcher", () => {
  test("a page carries the switcher and each valid product's colours for both modes, in order", async () => {
    const res = await get(web.origin, "/mcp");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes(TRIGGER));
    assert.ok(
      body.includes(
        "<style>:root{--product-cloud:oklch(0.53 0.1 175);--product-hub:oklch(0.52 0.18 295);}" +
          ".dark{--product-cloud:oklch(0.74 0.12 175);--product-hub:oklch(0.74 0.13 295);}" +
          ".telo-product-cloud{color:var(--product-cloud)}.telo-product-hub{color:var(--product-hub)}</style>",
      ),
    );
    // The menu is drawn on open; the page hands it the valid entries only.
    assert.ok(body.includes(`${accounts.origin}/v1/products/cloud.0123456789abcdef.svg`));
    assert.ok(!body.includes("evil.example"));
    assert.ok(!body.includes("studio.example"));
    assert.match(web.stderr(), /entry 2 \("marketplace"\): icon is not on the accounts origin/);
    assert.match(web.stderr(), /entry 3 \("studio"\): color\.dark is not an oklch colour/);
  });

  test("with accounts down the page is still a 200, without a switcher", async () => {
    const res = await get(accountsDown.origin, "/mcp");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(!body.includes(TRIGGER));
    assert.ok(!body.includes("--product-"));
    assert.match(accountsDown.stderr(), /could not refresh the Telo products/);
  });
});
