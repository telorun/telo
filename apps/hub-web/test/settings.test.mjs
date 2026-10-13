import assert from "node:assert/strict";
import { test } from "node:test";

import { runServer } from "./harness.mjs";

test("startup is refused without SITE_ORIGIN, naming it", async () => {
  const child = runServer({ HUB_API_ORIGIN: "http://127.0.0.1:1" });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /SITE_ORIGIN is required/);
});

test("startup is refused with an identity provider and no client id, naming it", async () => {
  const child = runServer({
    HUB_API_ORIGIN: "http://127.0.0.1:1",
    SITE_ORIGIN: "https://hub.example",
    OIDC_ISSUER: "https://accounts.example",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /OIDC_CLIENT_ID is required when OIDC_ISSUER is set/);
});

test("startup is refused with an analytics script that is not a URL, naming it", async () => {
  const child = runServer({
    HUB_API_ORIGIN: "http://127.0.0.1:1",
    SITE_ORIGIN: "https://hub.example",
    PLAUSIBLE_SCRIPT_URL: "analytics.example/js/script.js",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /PLAUSIBLE_SCRIPT_URL must be an absolute http\(s\) URL/);
});
