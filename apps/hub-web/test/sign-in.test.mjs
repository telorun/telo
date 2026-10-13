import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { get, startHubWeb, startStubHub } from "./harness.mjs";

const ISSUER = "https://accounts.example";
const CLIENT_ID = "telo-hub-web";

let hub;
let web;
let anonymousOnly;

before(async () => {
  hub = await startStubHub();
  web = await startHubWeb({
    hubOrigin: hub.origin,
    env: { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT_ID },
  });
  anonymousOnly = await startHubWeb({ hubOrigin: hub.origin });
});

after(async () => {
  await web?.stop();
  await anonymousOnly?.stop();
  await hub?.close();
});

describe("sign-in", () => {
  test("the silent page is never stored, sends no referrer and only answers its frame", async () => {
    const res = await get(web.origin, "/auth/silent?code=abc&state=xyz");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const body = await res.text();
    assert.match(body, /window\.parent\.postMessage\(\{type:"hub\.auth\.silent",search:location\.search\},location\.origin\)/);
    // The response is not the app: nothing in it starts a second check.
    assert.doesNotMatch(body, /\/assets\//);
  });

  test("the callback page is never stored, sends no referrer and is not indexed", async () => {
    const res = await get(web.origin, "/auth/callback?code=abc&state=xyz");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(await res.text(), /<meta name="robots" content="noindex"\/>/);
  });

  test("a page hands the browser the provider and client id, and stays cacheable and cookieless", async () => {
    const res = await get(web.origin, "/mcp");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60, stale-if-error=86400");
    assert.equal(res.headers.get("set-cookie"), null);
    const body = await res.text();
    assert.ok(body.includes(ISSUER));
    assert.ok(body.includes(CLIENT_ID));
    // Who is signed in is never in the markup.
    assert.ok(!/Sign in|Sign out/.test(body));
  });

  test("a site with no provider configured names none", async () => {
    const body = await (await get(anonymousOnly.origin, "/mcp")).text();
    assert.ok(!/Sign in|Sign out/.test(body));
    assert.ok(!body.includes("clientId"));
  });

  test("an unconfigured site loads nothing from a third party", async () => {
    const body = await (await get(anonymousOnly.origin, "/mcp")).text();
    const sources = [...body.matchAll(/<(?:script|link|img|iframe)[^>]*\s(?:src|href)="(https?:)?\/\/[^"]*"/g)]
      .map((match) => match[0])
      .filter((tag) => !tag.includes('rel="canonical"'));
    assert.deepEqual(sources, []);
    assert.ok(!body.includes("window.plausible"));
  });
});
