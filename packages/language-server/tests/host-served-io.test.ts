import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES, HarnessHost, uri } from "./harness.js";

const REMOTE = "oci://registry.example.test/telo/remote@1.0.0";

// The engine owns no transport: a relative import and an `oci://` import are
// both read through `telo/read`, served here by a host that has the remote
// module only in memory — so an analysis that resolves `Remote.Tick` proves no
// other path was taken.
it("reads every module through the host", async () => {
  const host = new HarnessHost({
    remote: { [REMOTE]: readFileSync(join(FIXTURES, "remote", "telo.yaml"), "utf8") },
  });
  await host.start();
  const consumer = join(FIXTURES, "remote-consumer", "telo.yaml");
  host.open(consumer);
  await host.published(consumer);

  expect(host.diagnostics().get(consumer)).toEqual([]);
  const read = host.requests.filter((r) => r.method === "telo/read").map((r) => r.params.uri);
  expect(read).toContain(REMOTE);
  expect(read).toContain(uri(join(FIXTURES, "ledger")));
  expect(new Set(host.requests.map((r) => r.method))).toEqual(new Set(["telo/read"]));
});

it("references no network API in its source", () => {
  const dir = new URL("../src/", import.meta.url);
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
  const offenders = files.filter((file) => /\b(fetch|XMLHttpRequest|WebSocket)\b/.test(readFileSync(file, "utf8")));
  expect(offenders).toEqual([]);
});
