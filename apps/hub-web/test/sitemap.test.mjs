import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";

import { catalogueResponse, get, sendJson, startHubWeb, startStubHub } from "./harness.mjs";

const XML = `<?xml version="1.0" encoding="UTF-8"?>\n`;
const NS = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`;

/** Sparse on purpose: shard 2 has no modules. */
const CATALOGUE = [
  { ref: "oci://example.com/a", latestVersion: "1.0.0", seq: 3 },
  { ref: "https://example.com/b/telo.yaml", latestVersion: "1.0.0", seq: 49_999 },
  { ref: "oci://example.com/c", latestVersion: "1.0.0", seq: 50_000 },
  { ref: "oci://example.com/d", latestVersion: "1.0.0", seq: 50_001 },
  { ref: "oci://example.com/e", latestVersion: "1.0.0", seq: 150_002 },
];

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

function serveCatalogue(entries) {
  hub.handle = (req, res, url) => sendJson(res, 200, catalogueResponse(entries, url));
}

test("the index lists every non-empty shard, one probe per shard", async () => {
  serveCatalogue(CATALOGUE);
  hub.requests.length = 0;
  const res = await get(web.origin, "/sitemap.xml");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(
    await res.text(),
    `${XML}<sitemapindex ${NS}>\n` +
      [0, 1, 3]
        .map((k) => `<sitemap><loc>https://hub.example/sitemaps/modules-${k}.xml</loc></sitemap>`)
        .join("\n") +
      `\n</sitemapindex>\n`,
  );
  assert.deepEqual(hub.requests, [
    "/modules?after=0&limit=1",
    "/modules?after=50000&limit=1",
    "/modules?after=100000&limit=1",
    "/modules?after=200000&limit=1",
  ]);
});

test("a shard holds the canonical pages of its seq range", async () => {
  serveCatalogue(CATALOGUE);
  const shard = async (k) => {
    const res = await get(web.origin, `/sitemaps/modules-${k}.xml`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    return res.text();
  };
  const urlset = (...paths) =>
    `${XML}<urlset ${NS}>\n` +
    paths.map((p) => `<url><loc>https://hub.example${p}</loc></url>\n`).join("") +
    `</urlset>\n`;

  assert.equal(
    await shard(0),
    urlset(
      "/module/oci/example.com/a/",
      "/module/url/example.com/b/telo.yaml/",
      "/module/oci/example.com/c/",
    ),
  );
  assert.equal(await shard(1), urlset("/module/oci/example.com/d/"));
  assert.equal(await shard(2), urlset());
});

test("a shard skips every ref without a page", async () => {
  serveCatalogue(
    [
      "https://example.com/a?b/telo.yaml",
      "https://example.com/a#b/telo.yaml",
      "https://example.com/a/../telo.yaml",
      "http://example.com/c/telo.yaml",
      "oci://example.com/p%41th",
      "./modules/seed",
      "oci://example.com/ok",
    ].map((ref, i) => ({ ref, latestVersion: "1.0.0", seq: i + 1 })),
  );
  const res = await get(web.origin, "/sitemaps/modules-0.xml");
  assert.equal(
    await res.text(),
    `${XML}<urlset ${NS}>\n<url><loc>https://hub.example/module/oci/example.com/ok/</loc></url>\n</urlset>\n`,
  );
});

test("a shard name that is not modules-<k>.xml is a 404", async () => {
  for (const name of ["modules-x.xml", "modules--1.xml", "modules-01.xml", "other.xml"]) {
    assert.equal((await get(web.origin, `/sitemaps/${name}`)).status, 404, name);
  }
});

test("a hub failure before a shard starts is a 503", async () => {
  hub.handle = (req, res) => sendJson(res, 500, {});
  const res = await get(web.origin, "/sitemaps/modules-0.xml");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a hub failure mid-shard resets the connection without </urlset>", async () => {
  const dense = Array.from({ length: 1500 }, (_, i) => ({
    ref: `oci://example.com/m${i + 1}`,
    latestVersion: "1.0.0",
    seq: i + 1,
  }));
  hub.handle = (req, res, url) =>
    url.searchParams.get("after") === "0"
      ? sendJson(res, 200, catalogueResponse(dense, url))
      : sendJson(res, 500, {});

  const outcome = await new Promise((resolve) => {
    const req = request(`${web.origin}/sitemaps/modules-0.xml`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("error", (error) => resolve({ status: res.statusCode, body, error }));
      res.on("end", () => resolve({ status: res.statusCode, body, error: null }));
    });
    req.on("error", (error) => resolve({ status: null, body: "", error }));
    req.end();
  });

  assert.equal(outcome.status, 200);
  assert.ok(outcome.error, "the response ended cleanly");
  assert.equal(outcome.error.code, "ECONNRESET");
  assert.match(outcome.body, /<url><loc>https:\/\/hub.example\/module\/oci\/example.com\/m1000\/<\/loc><\/url>/);
  assert.ok(!outcome.body.includes("</urlset>"));
  // One connection is dropped, not the server.
  assert.equal((await get(web.origin, "/health")).status, 200);
  assert.match(web.stderr(), /sitemap shard 0 aborted mid-stream: hub unavailable \(status\)/);
});
