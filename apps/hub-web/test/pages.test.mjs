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
    assert.ok(html.includes('href="/module/oci/example.com/acme/base/#kind-Base"'));
  });

  test("an application's input says which configurations require it, in its environment's names", async () => {
    hub.handle = (req, res) =>
      sendJson(res, 200, {
        ...modulePage("1.0.0"),
        kinds: [],
        application: {
          variables: [],
          secrets: [
            { name: "openaiApiKey", description: "", required: false, env: "OPENAI_API_KEY", schema: { type: "string" } },
            {
              name: "anthropicApiKey",
              description: "",
              required: true,
              requiredWhen: [{ "secrets.openaiApiKey": "absent" }],
              env: "ANTHROPIC_API_KEY",
              schema: { type: "string" },
            },
            {
              name: "pgPassword",
              description: "",
              required: true,
              requiredWhen: [{ "secrets.databaseUrl.scheme": "postgres" }],
              env: "PG_PASSWORD",
              schema: { type: "string" },
            },
          ],
          ports: [],
          dimensions: [
            { key: "secrets.openaiApiKey", values: ["present", "absent"], env: ["OPENAI_API_KEY"] },
            { key: "secrets.databaseUrl.scheme", values: ["postgres", "mysql"], env: ["DATABASE_URL"], member: "scheme" },
          ],
        },
      });
    const html = await (await get(web.origin, PAGE)).text();
    assert.ok(html.includes("required when OPENAI_API_KEY is unset"));
    assert.ok(html.includes("required when the scheme of DATABASE_URL is postgres"));
    assert.equal(html.match(/>required</g), null);
  });
});

/** The two reads a catalogue page is seeded from, over one category `tools`. */
function answerCatalogue(req, res, url) {
  if (url.pathname === "/categories") {
    return sendJson(res, 200, {
      categories: [{ category: "tools", label: "Tools", modules: 1, kinds: 1 }],
    });
  }
  if (url.pathname === "/publishers") {
    return sendJson(res, 200, { publishers: [{ publisher: "example.com/acme", modules: 1 }] });
  }
  if (url.pathname === "/search/modules") {
    const category = url.searchParams.get("category") ?? "";
    if (category && category !== "tools") {
      return sendJson(res, 400, { error: `unknown category "${category}"` });
    }
    return sendJson(res, 200, {
      // A hub that applies the publisher filter echoes it; `oldHub` is one that
      // predates the parameter and answers as if it were not there.
      ...(answerCatalogue.oldHub ? {} : { publisher: url.searchParams.get("publisher") ?? "" }),
      total: 1,
      hits: [
        {
          module: { ref: REF, version: "1.0.0", name: "Widget", description: "Makes widgets." },
          score: 0,
          matchedKinds: [{ entry: "kind", name: "Gadget", kind: "Gadget", capability: "Telo.Invocable", description: "", score: 0 }],
          exportedKinds: [{ kind: "Gadget", capability: "Telo.Invocable", description: "" }],
          exportedResources: [],
        },
      ],
    });
  }
  sendJson(res, 404, { error: "no such route" });
}

describe("catalogue", () => {
  test("home lists the first page of modules and the categories in its markup", async () => {
    hub.handle = answerCatalogue;
    const html = await (await get(web.origin, "/")).text();
    assert.ok(html.includes(`href="${PAGE}"`), "the module card links to its page");
    assert.ok(html.includes('href="/category/tools"'));
  });

  test("the seeded listing and facets cover libraries and applications alike", async () => {
    hub.handle = answerCatalogue;
    const before = hub.requests.length;
    await (await get(web.origin, "/")).text();
    const all = "entry=kind&entry=instance&entry=application";
    for (const path of ["/search/modules", "/categories", "/publishers"]) {
      assert.ok(
        hub.requests.slice(before).some((r) => r.startsWith(path) && r.includes(all)),
        `${path} was asked for every entry type`,
      );
    }
  });

  test("home is still a 200 when the hub answers nothing", async () => {
    hub.handle = (req, res) => sendJson(res, 500, { error: "db exploded" });
    const res = await get(web.origin, "/");
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes("db exploded"));
  });

  test("a category the hub knows is a 200 page with its own head", async () => {
    hub.handle = answerCatalogue;
    const res = await get(web.origin, "/category/tools");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60, stale-if-error=86400");
    assert.match(html, /<title>Tools modules — Telo Hub<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/hub.example\/category\/tools"\/>/);
    assert.match(html, /<h1[^>]*>Tools<\/h1>/);
    assert.ok(html.includes(`href="${PAGE}"`));
  });

  test("a category has one address: other spellings are a 301 or a 404", async () => {
    hub.handle = (req, res, url) => {
      // The hub itself reads `Tools` as `tools`.
      if (url.searchParams.get("category") === "Tools") url.searchParams.set("category", "tools");
      answerCatalogue(req, res, url);
    };
    const slash = await get(web.origin, "/category/tools/?runtime=rust");
    assert.equal(slash.status, 301);
    assert.equal(slash.headers.get("location"), "/category/tools?runtime=rust");
    assert.equal((await get(web.origin, "/category/Tools")).status, 404);
  });

  test("a publisher has one address: a trailing slash is a 301", async () => {
    const res = await get(web.origin, "/publisher/example.com/acme/");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/publisher/example.com/acme");
  });

  test("a category no module declares is a 404", async () => {
    hub.handle = answerCatalogue;
    const res = await get(web.origin, "/category/nothing");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  test("a category page is a 503 when the hub does not answer", async () => {
    hub.handle = (req, res) => sendJson(res, 500, { error: "db exploded" });
    const res = await get(web.origin, "/category/tools");
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "60");
  });

  test("the old ?category= address is a 301 to the category page, filters kept", async () => {
    const res = await get(web.origin, "/?category=tools&q=widgets&runtime=rust");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/category/tools?q=widgets&runtime=rust");
  });

  test("a publisher the hub lists is a 200 page with its own head", async () => {
    hub.handle = answerCatalogue;
    const res = await get(web.origin, "/publisher/example.com/acme");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<title>Modules published on example.com\/acme — Telo Hub<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/hub.example\/publisher\/example.com\/acme"\/>/);
    assert.ok(html.includes(`href="${PAGE}"`));
    assert.ok(hub.requests.some((r) => r.includes("publisher=example.com%2Facme")));
  });

  test("a publisher the hub does not list is a 404", async () => {
    hub.handle = answerCatalogue;
    assert.equal((await get(web.origin, "/publisher/example.com/nobody")).status, 404);
  });

  test("a hub that ignores the publisher filter is a 503, never an unfiltered list", async () => {
    answerCatalogue.oldHub = true;
    hub.handle = answerCatalogue;
    const res = await get(web.origin, "/publisher/example.com/acme");
    answerCatalogue.oldHub = false;
    assert.equal(res.status, 503);
    assert.match(web.stderr(), /cannot filter by publisher/);
  });

  test("the ?publisher= address on home is a 301 to the publisher page", async () => {
    const res = await get(web.origin, "/?publisher=example.com/acme&sort=name");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/publisher/example.com/acme?sort=name");
  });

  test("a kind's fields are read from the version's manifest", async () => {
    hub.handle = (req, res, url) => {
      if (url.pathname !== "/module/manifest") return answerModule(req, res, url);
      res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
      res.end(
        [
          "kind: Telo.Library",
          "metadata: { name: Widget }",
          "---",
          "kind: Telo.Definition",
          "metadata: { name: Gadget }",
          "capability: Telo.Invocable",
          "schema:",
          "  type: object",
          "  required: [size]",
          "  properties:",
          "    size: { type: integer, description: How big it is. }",
          '    target: { x-telo-ref: { kind: Self.Socket, use: call } }',
          '    label: { type: string, default: !cel "variables.label" }',
        ].join("\n"),
      );
    };
    const html = await (await get(web.origin, PAGE)).text();
    assert.ok(html.includes("How big it is."));
    assert.ok(html.includes("ref → Self.Socket"));
    assert.ok(html.includes("variables.label"));
  });

  test("a module page without a manifest is still a 200, without field tables", async () => {
    hub.handle = answerModule;
    const res = await get(web.origin, PAGE);
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes("Manifest source"));
  });

  test("a listing asks the hub to leave deprecated modules out, and says how many it left", async () => {
    let asked;
    hub.handle = (req, res, url) => {
      if (url.pathname !== "/search/modules") return answerCatalogue(req, res, url);
      asked = url.searchParams;
      sendJson(res, 200, { deprecated: "exclude", total: 0, hidden: { deprecated: 3, contractOnly: 0 }, hits: [] });
    };
    const html = await (await get(web.origin, "/")).text();
    assert.equal(asked.get("deprecated"), "exclude");
    assert.equal(asked.get("contractOnly"), null);
    assert.ok(!html.includes(`href="${PAGE}"`));
    assert.match(html, /3<!-- --> deprecated hidden|3 deprecated hidden/);
  });

  test("a listing from a hub that leaves nothing out is shown as answered", async () => {
    hub.handle = answerCatalogue;
    const html = await (await get(web.origin, "/")).text();
    assert.ok(html.includes(`href="${PAGE}"`));
    assert.ok(!html.includes("deprecated hidden"));
  });

  test("the MCP page names the hub's endpoint on the browser origin", async () => {
    const res = await get(web.origin, "/mcp");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<title>Connect over MCP — Telo Hub<\/title>/);
    assert.ok(html.includes(`${hub.origin}/mcp`));
  });

  test("register is a page of its own", async () => {
    const res = await get(web.origin, "/register");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<title>Register a module — Telo Hub<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/hub.example\/register"\/>/);
  });

  test("a module page links the modules using it and implementing its contracts", async () => {
    hub.handle = (req, res, url) => {
      if (url.pathname === "/module") {
        return sendJson(res, 200, {
          ...modulePage("1.0.0"),
          kinds: [{ kind: "Socket", capability: "Telo.Provider", abstract: true, description: "" }],
          dependents: 1,
        });
      }
      if (url.pathname === "/dependents") {
        return sendJson(res, 200, {
          dependents: [{ ref: "oci://example.com/acme/user", version: "1.0.0", name: "User", description: "" }],
        });
      }
      if (url.pathname === "/implementations") {
        return sendJson(res, 200, {
          implementations: [
            { ref: "oci://example.com/acme/plug", version: "1.0.0", kind: "Socket", capability: "", description: "" },
          ],
        });
      }
      sendJson(res, 404, {});
    };
    const html = await (await get(web.origin, PAGE)).text();
    assert.ok(html.includes('href="/module/oci/example.com/acme/user/"'));
    assert.ok(html.includes('href="/module/oci/example.com/acme/plug/#kind-Socket"'));
  });

  test("a module page states what it is as structured data", async () => {
    hub.handle = answerModule;
    const html = await (await get(web.origin, PAGE)).text();
    assert.ok(html.includes('"@type":"SoftwareSourceCode"'));
    assert.ok(html.includes('"@type":"BreadcrumbList"'));
    assert.ok(html.includes(`"identifier":"${REF}"`));
    assert.ok(!html.includes(HOSTILE), "a hostile description reaches the document unescaped");
  });

  test("a module page carries the tags a pasted link unfurls from", async () => {
    hub.handle = answerModule;
    const html = await (await get(web.origin, PAGE)).text();
    assert.ok(html.includes('<meta property="og:title" content="Widget — Telo Hub"/>'));
    assert.ok(html.includes(`<meta property="og:url" content="https://hub.example${PAGE}"/>`));
  });
});

describe("site", () => {
  test("home is a 200 page with its head and canonical", async () => {
    const res = await get(web.origin, "/");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60, stale-if-error=86400");
    assert.match(html, /<title>Telo Hub — find a module, on any host<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/hub.example\/"\/>/);
    assert.ok(!html.includes('name="robots"'));
    assert.ok(html.includes('"@type":"WebSite"'));
  });

  test("a filtered listing keeps the listing's canonical", async () => {
    const html = await (await get(web.origin, "/?runtime=rust&type=library&sort=name")).text();
    assert.match(html, /<link rel="canonical" href="https:\/\/hub.example\/"\/>/);
    assert.ok(!html.includes('name="robots"'));
  });

  test("a search-results address is noindex and names no canonical", async () => {
    const html = await (await get(web.origin, "/?q=widgets")).text();
    assert.match(html, /value="widgets"/);
    assert.ok(html.includes('<meta name="robots" content="noindex, follow"/>'));
    assert.ok(!html.includes('rel="canonical"'));
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
