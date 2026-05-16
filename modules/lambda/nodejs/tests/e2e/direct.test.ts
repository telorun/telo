import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directManifest } from "../helpers/manifests.js";
import { buildFixture, type Fixture } from "../helpers/prepare-fixture.js";
import { invokeRie, startRie, type StartedRie } from "../helpers/rie-container.js";

/** Lambda.Direct end-to-end through the real bootstrap + AWS Lambda Runtime
 *  Interface Emulator. The managed case drives the bootstrap-exported
 *  `handler`; the custom case drives the bootstrap's poll loop against the
 *  Runtime API. Both share the same telo.yaml — only the bootstrap differs. */

describe.each([
  { mode: "managed" as const },
  { mode: "custom" as const },
])("Lambda.Direct E2E ($mode)", ({ mode }) => {
  let fixture: Fixture;
  let rie: StartedRie;

  beforeAll(async () => {
    fixture = await buildFixture({ name: `direct-${mode}`, telo: directManifest, mode });
    rie = await startRie({ fixtureDir: fixture.dir, mode });
  });

  afterAll(async () => {
    if (rie) await rie.stop();
    if (fixture) fixture.cleanup();
  });

  it("dispatches a synthetic event through Direct → JS handler and returns the result", async () => {
    const event = { user: "alice", value: 42 };
    const response = await invokeRie(rie.invokeUrl, event);
    expect(response).toEqual({ received: { payload: event } });
  });

  it("classifies an opaque payload to Direct (catch-all) when no other handler kind matches", async () => {
    const response = await invokeRie(rie.invokeUrl, { arbitrary: "shape" });
    expect(response).toEqual({ received: { payload: { arbitrary: "shape" } } });
  });
});
