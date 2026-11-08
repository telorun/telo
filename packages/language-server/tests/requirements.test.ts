import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES, HarnessHost, canonical } from "./harness.js";

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
    owner: canonical(owner),
    documents: [canonical(owner), canonical(join(FIXTURES, "billing", "handlers.yaml"))],
    ranges: [
      {
        module: canonical(owner),
        text: ">=0.100.0",
        interval: { min: { version: "0.100.0", inclusive: true } },
      },
      {
        module: canonical(join(FIXTURES, "ledger", "telo.yaml")),
        text: ">=0.90.0 <99.0.0",
        interval: {
          min: { version: "0.90.0", inclusive: true },
          max: { version: "99.0.0", inclusive: false },
        },
      },
    ],
  });
});

it("reports a module at >=unreleased with a lower edge no released version meets", async () => {
  const host = new HarnessHost();
  await host.start();
  const owner = join(FIXTURES, "unreleased", "telo.yaml");
  host.open(owner);
  await host.until(
    () => host.notifications.some((n) => n.method === "telo/requirements"),
    "telo/requirements",
  );
  const params = host.notifications.find((n) => n.method === "telo/requirements")!.params;
  expect(params.ranges).toEqual([
    {
      module: canonical(owner),
      text: ">=unreleased",
      interval: { min: { version: "999999.0.0", inclusive: true } },
    },
  ]);
});

it("reports a dependency's load range narrowed by its own restriction, and gates the pin on it", async () => {
  const host = new HarnessHost();
  await host.start();
  const owner = join(FIXTURES, "restricted", "app", "telo.yaml");
  host.open(owner);
  await host.until(
    () => host.notifications.some((n) => n.method === "telo/requirements"),
    "telo/requirements",
  );
  const params = host.notifications.find((n) => n.method === "telo/requirements")!.params;
  expect(params.ranges).toEqual([
    {
      module: canonical(join(FIXTURES, "restricted", "lib", "telo.yaml")),
      text: ">=0.1.0 <0.2.0",
      interval: {
        min: { version: "0.1.0", inclusive: true },
        max: { version: "0.2.0", inclusive: false },
      },
    },
  ]);
  await host.published(owner);
  const codes = [...host.diagnostics().values()].flat().map((d) => d.code);
  expect(codes).toContain("MODULE_REQUIRES_OLDER_RUNTIME");
});
