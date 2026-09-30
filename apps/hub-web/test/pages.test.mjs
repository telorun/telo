import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { closedPortOrigin, get, sendJson, startHubWeb, startStubHub } from "./harness.mjs";

const REF = "oci://example.com/acme/widget";
const PAGE = "/module/oci/example.com/acme/widget/";
const HOSTILE = "</script><script>alert(1)</script>";

function modulePage(version, ref = REF) {
  return {
    module: {
      ref,
      version,
      latestVersion: "1.0.0",
      name: "Widget",
      transport: "oci",
      integrity: "",
      description: `Makes widgets. ${HOSTILE}`,
    },
    kinds: [{ kind: "Gadget", capability: "Telo.Invocable", description: "" }],
    exportedResources: [],
    versions: ["1.0.0", "0.9.0"],
  };
}

/** The module route answering for `REF` at its two tracked versions. */
function answerModule(req, res, url) {
  const version = url.searchParams.get("version") || "1.0.0";
  if (url.pathname !== "/module" || url.searchParams.get("ref") !== REF) {
    return sendJson(res, 404, { error: "Module not tracked" });
  }
  if (version !== "1.0.0" && version !== "0.9.0") {
    return sendJson(res, 404, { error: "Module not tracked" });
  }
  sendJson(res, 200, modulePage(version));
}

let hub;
let web;

before(async () => {
  hub = await startStubHub();
  web = await startHubWeb({ hubOrigin: hub.origin });
});

after(async () => {
  await web?.stop();
  await hub?.close();
});

describe("module page", () => {
  test("a module the hub answers for is a 200 page with its head", async () => {
    hub.handle = answerModule;
    const res = await get(web.origin, PAGE);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60, stale-if-error=86400");
    assert.match(html, /<title>Widget — Telo Hub<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/hub.example\/module\/oci\/example.com\/acme\/widget\/"\/>/);
    assert.match(html, /<h1[^>]*>Widget<\/h1>/);
    assert.match(html, />Gadget</);
  });

  test("a tracked version is a 200 whose canonical is the unversioned page", async () => {
    hub.handle = answerModule;
    const res = await get(web.origin, `${PAGE}?version=0.9.0`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<link rel="canonical" href="https:\/\/hub.example\/module\/oci\/example.com\/acme\/widget\/"\/>/);
    assert.match(html, /v<!-- -->0.9.0/);
  });

  test("a description holding </script> renders as text on first load", async () => {
    hub.handle = answerModule;
    const html = await (await get(web.origin, PAGE)).text();
    assert.ok(!html.includes(HOSTILE), "the raw markup reaches the document");
    assert.ok(html.includes("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  });

  test("an unknown module or version is one 404 body linking to the canonical page", async () => {
    hub.handle = answerModule;
    for (const target of ["/module/oci/example.com/acme/nothing/", `${PAGE}?version=7.0.0`]) {
      const res = await get(web.origin, target);
      const html = await res.text();
      assert.equal(res.status, 404, target);
      assert.equal(res.headers.get("cache-control"), "no-cache", target);
      assert.match(html, /Module not found/, target);
      assert.match(html, new RegExp(`href="${target.split("?")[0]}"`), target);
    }
  });

  test("a hub 500 is a 503 with Retry-After and no-store, and no detail", async () => {
    hub.handle = (req, res) => sendJson(res, 500, { error: "db exploded" });
    const res = await get(web.origin, PAGE);
    const html = await res.text();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!html.includes("db exploded") && !html.includes("answered 500"));
    assert.match(web.stderr(), /hub unavailable \(status\).*answered 500/);
  });

  test("an unreadable hub body is a 503", async () => {
    hub.handle = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{not json");
    };
    assert.equal((await get(web.origin, PAGE)).status, 503);
  });

  test(
    "a hub silent for 10 s, before its headers or between body chunks, is a 503",
    { timeout: 30_000 },
    async () => {
      const stalled = [];
      hub.handle = (req, res, url) => {
        stalled.push(res);
        if (url.searchParams.get("version") === "0.9.0") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write('{"module":');
        }
      };
      const started = Date.now();
      const [headers, body] = await Promise.all([
        get(web.origin, PAGE),
        get(web.origin, `${PAGE}?version=0.9.0`),
      ]);
      assert.ok(Date.now() - started >= 9_900);
      assert.equal(headers.status, 503);
      assert.equal(body.status, 503);
      assert.match(web.stderr(), /hub unavailable \(silent\).*no response headers/);
      assert.match(web.stderr(), /hub unavailable \(silent\).*body stalled/);
      for (const res of stalled) res.destroy();
    },
  );

  test("a module path without the trailing slash is a 301 keeping the query", async () => {
    const res = await get(web.origin, "/module/oci/example.com/acme/widget?version=0.9.0");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), `${PAGE}?version=0.9.0`);
  });

  test("a /module/ path whose ref has no page is a 404 with no hub request", async () => {
    const before = hub.requests.length;
    for (const target of [
      "/module/oci/%252e%252e/%252e%252e//evil.com/",
      "/module/oci/a%3Fb/",
      "/module/oci/a%23b/",
      "/module/oci/a%5Cb/",
      "/module/oci/a%00b/",
      "/module/oci/a%25b/",
      "/module/oci/a%20b/",
      "/module/oci//evil.com/",
      "/module/oci/a/%252e/b/",
      "/module/local/modules/x/",
    ]) {
      const res = await get(web.origin, target);
      await res.arrayBuffer();
      assert.equal(res.status, 404, target);
      assert.equal(res.headers.get("cache-control"), "no-cache", target);
      assert.equal(res.headers.get("location"), null, target);
    }
    assert.equal(hub.requests.length, before);
  });

  test("a non-canonical spelling of a page is a 301 to the literal page path", async () => {
    for (const target of ["/module/oci/example.com/acme/%77idget/", "/module/oci/example.com/acme/widget//"]) {
      const res = await get(web.origin, target);
      assert.equal(res.status, 301, target);
      assert.equal(res.headers.get("location"), PAGE, target);
    }
  });

  test("a ref using the path alphabet is a 200 at its verbatim path", async () => {
    const ref = "oci://registry.example:5000/acme/widget";
    hub.handle = (req, res, url) =>
      url.searchParams.get("ref") === ref
        ? sendJson(res, 200, modulePage("1.0.0", ref))
        : sendJson(res, 404, { error: "Module not tracked" });
    const res = await get(web.origin, "/module/oci/registry.example:5000/acme/widget/");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(
      html.includes(
        '<link rel="canonical" href="https://hub.example/module/oci/registry.example:5000/acme/widget/"/>',
      ),
    );
  });

  test("a kind re-exported from a ref without a page names it as text", async () => {
    hub.handle = (req, res) =>
      sendJson(res, 200, {
        ...modulePage("1.0.0"),
        kinds: [
          { kind: "Local", capability: "Telo.Invocable", description: "", reexported: true, ref: "./modules/x" },
          {
            kind: "Base",
            capability: "Telo.Invocable",
            description: "",
            reexported: true,
            ref: "oci://example.com/acme/base",
          },
        ],
      });
    const html = await (await get(web.origin, PAGE)).text();
    assert.ok(html.includes('<code class="font-mono break-all">./modules/x</code>'));
    assert.ok(!html.includes('href="/module/local'));
    assert.ok(html.includes('href="/module/oci/example.com/acme/base/"'));
  });
});

describe("site", () => {
  test("home is a 200 page with its head and canonical", async () => {
    const res = await get(web.origin, "/?q=widgets");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60, stale-if-error=86400");
    assert.match(html, /<title>Telo Hub — find a module, on any host<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/hub.example\/"\/>/);
    assert.match(html, /value="widgets"/);
  });

  test("an unmatched path is a 404 with no-cache", async () => {
    const res = await get(web.origin, "/nope");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  test("robots.txt names the sitemap on the site origin", async () => {
    const res = await get(web.origin, "/robots.txt");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(
      await res.text(),
      "User-agent: *\nAllow: /\nSitemap: https://hub.example/sitemap.xml\n",
    );
  });

  test("built assets are immutable, and a missing one is the app's 404", async () => {
    const assetsDir = path.resolve(import.meta.dirname, "../build/client/assets");
    const asset = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
    const res = await get(web.origin, `/assets/${asset}`);
    await res.arrayBuffer();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const missing = await get(web.origin, "/assets/missing.js");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-cache");
  });
});

describe("hub down", () => {
  let downWeb;

  before(async () => {
    downWeb = await startHubWeb({ hubOrigin: await closedPortOrigin() });
  });

  after(async () => {
    await downWeb?.stop();
  });

  test("a refused connection is a 503", async () => {
    const res = await get(downWeb.origin, PAGE);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.match(downWeb.stderr(), /hub unavailable \(refused\)/);
  });

  test("/health answers 200 without the hub", async () => {
    const res = await get(downWeb.origin, "/health");
    assert.equal(res.status, 200);
  });
});
