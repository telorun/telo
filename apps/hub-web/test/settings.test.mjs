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
