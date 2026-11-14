import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { HarnessHost } from "./harness.js";

const root = mkdtempSync(join(tmpdir(), "telo-engine-library-"));
const lib = join(root, "lib");
mkdirSync(lib);
writeFileSync(
  join(root, "telo.yaml"),
  "kind: Telo.Application\nmetadata:\n  name: Consumer\n  version: 1.0.0\nimports:\n  Lib: ./lib\n",
);
writeFileSync(
  join(lib, "telo.yaml"),
  "kind: Telo.Library\nmetadata:\n  name: Broken\n  version: 1.0.0\n---\nkind: Telo.Value\nmetadata:\n  name: incomplete\n",
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

// A library's finding reaches the editor once, whether the library is analysed
// as its own owner, through its consumer, or both.
it("publishes a library's finding once when library and consumer are both open", async () => {
  const host = new HarnessHost();
  await host.start();
  host.open(join(root, "telo.yaml"));
  host.open(join(lib, "telo.yaml"));
  await host.published(join(lib, "telo.yaml"));
  await host.until(
    () => host.notifications.filter((n) => n.method === "telo/viewModelChanged").length >= 2,
    "both owners' analyses",
  );
  const found = host.diagnostics();
  expect(found.get(join(lib, "telo.yaml"))!.map((d) => d.code)).toEqual(["SCHEMA_VIOLATION"]);
  expect(found.get(join(root, "telo.yaml"))).toEqual([]);
});
