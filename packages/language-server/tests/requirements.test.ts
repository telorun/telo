import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES, HarnessHost, uri } from "./harness.js";

// A host routes an owner's documents to one engine and picks that engine's
// version from these intervals, comparing plain versions only — so the owner,
// its members and every range in its closure arrive already normalized.
it("emits telo/requirements for an analysed owner", async () => {
  const host = new HarnessHost();
  await host.start();
  const owner = join(FIXTURES, "billing", "telo.yaml");
  host.open(owner);
  await host.until(
    () => host.notifications.some((n) => n.method === "telo/requirements"),
    "telo/requirements",
  );
  const params = host.notifications.find((n) => n.method === "telo/requirements")!.params;
  expect(params).toEqual({
    owner: uri(owner),
    documents: [uri(owner), uri(join(FIXTURES, "billing", "handlers.yaml"))],
    ranges: [
      {
        module: uri(owner),
        text: ">=0.100.0",
        interval: { min: { version: "0.100.0", inclusive: true } },
      },
      {
        module: uri(join(FIXTURES, "ledger", "telo.yaml")),
        text: ">=0.90.0 <99.0.0",
        interval: {
          min: { version: "0.90.0", inclusive: true },
          max: { version: "99.0.0", inclusive: false },
        },
      },
    ],
  });
});
