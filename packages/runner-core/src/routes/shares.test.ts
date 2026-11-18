import { afterEach, describe, expect, it } from "vitest";

import type { IdentityConfig } from "../config.js";
import type { CallerResolver } from "../session/session-credentials.js";
import { ShareRetention } from "../session-store/share-retention.js";
import {
  bootTestServer,
  FakeWorkloadBackend,
  temporaryStore,
  TEST_SHARE_ROUTING,
  testConfig,
} from "../test-support/fake-workload-backend.js";
import { MemoryShareStore, withShares } from "../test-support/memory-share-store.js";

const IDENTITY: IdentityConfig = { audience: "https://runner.example.com", issuers: ["https://id.example"] };

/** `Authorization: Test <sub>` is an identity, `Bearer` a resume secret. */
const resolveCaller: CallerResolver = async (req) => {
  const header = req.headers.authorization ?? "";
  const test = /^Test (\S+)$/.exec(header);
  if (test) return { caller: { kind: "owner", owner: { kind: "identity", iss: "https://id.example", sub: test[1]! } } };
  if (header.startsWith("Bearer ")) {
    return { caller: { kind: "owner", owner: { kind: "secret", secretHash: "a".repeat(64) } } };
  }
  return { caller: { kind: "anonymous" } };
};

type Booted = Awaited<ReturnType<typeof bootTestServer>>;
const open: Array<{ booted: Booted; shares: MemoryShareStore }> = [];

afterEach(async () => {
  for (const { booted } of open.splice(0)) {
    await booted.server.app.close();
    await booted.store.dispose();
  }
});

async function boot(options: { maxPerOwner?: number; shares?: boolean } = {}) {
  const shares = new MemoryShareStore();
  const handle = await temporaryStore();
  const booted = await bootTestServer(
    {
      backend: new FakeWorkloadBackend({ shareRouting: TEST_SHARE_ROUTING }),
      config: testConfig({
        identity: IDENTITY,
        shares: {
          ...testConfig().shares,
          enabled: options.shares ?? true,
          maxPerOwner: options.maxPerOwner ?? 10,
        },
      }),
      resolveCaller,
      store: withShares(handle.store, shares),
    },
    handle,
  );
  open.push({ booted, shares });
  return { app: booted.server.app, shares, booted };
}

const as = (sub: string) => ({ authorization: `Test ${sub}` });

describe("/v1/shares", () => {
  it("creates a share, then answers the same object for the same name", async () => {
    const { app } = await boot();
    const body = { name: "demo", application: "WebhookDemo" };
    const created = await app.inject({ method: "POST", url: "/v1/shares", headers: as("alice"), payload: body });
    expect(created.statusCode).toBe(201);
    const share = created.json();
    expect(share).toEqual({
      id: expect.stringMatching(/^[a-z2-7]{12}$/),
      name: "demo",
      application: "WebhookDemo",
      publicUrlTemplate: `https://{port}-${share.id}.share.test`,
      publicUrlSecondaryTemplate: `https://{label}--{port}-${share.id}.share.test`,
      tunnelUrl: `wss://tunnel.share.test/v1/shares/${share.id}/tunnel`,
    });
    const again = await app.inject({ method: "POST", url: "/v1/shares", headers: as("alice"), payload: body });
    expect([again.statusCode, again.json()]).toEqual([200, share]);
    const other = await app.inject({ method: "POST", url: "/v1/shares", headers: as("bob"), payload: body });
    expect([other.statusCode, other.json().id === share.id]).toEqual([201, false]);
  });

  it("answers 429 at the owner's limit, in the plan's words", async () => {
    const { app } = await boot({ maxPerOwner: 1 });
    await app.inject({ method: "POST", url: "/v1/shares", headers: as("alice"), payload: { name: "a", application: "A" } });
    const res = await app.inject({ method: "POST", url: "/v1/shares", headers: as("alice"), payload: { name: "b", application: "A" } });
    expect([res.statusCode, res.json()]).toEqual([
      429,
      {
        error: "too_many_shares",
        message: "this runner keeps at most 1 shares per owner; delete one with telo shares delete <id>",
      },
    ]);
  });

  it("takes an identity: a resume secret is 403, no credential 401", async () => {
    const { app } = await boot();
    const secret = await app.inject({ method: "POST", url: "/v1/shares", headers: { authorization: "Bearer x" }, payload: { name: "a", application: "A" } });
    expect([secret.statusCode, secret.json().error]).toEqual([403, "identity_required"]);
    const none = await app.inject({ method: "GET", url: "/v1/shares" });
    expect([none.statusCode, none.json().error]).toEqual([401, "session_auth_required"]);
  });

  it("lists the caller's shares, newest activity first, with whether each is connected", async () => {
    const { app, shares } = await boot();
    const make = async (name: string) =>
      (await app.inject({ method: "POST", url: "/v1/shares", headers: as("alice"), payload: { name, application: "A" } })).json().id as string;
    const idle = await make("idle");
    const live = await make("live");
    await make("other");
    await app.inject({ method: "POST", url: "/v1/shares", headers: as("bob"), payload: { name: "bobs", application: "A" } });
    await shares.connectShare({
      id: live,
      epoch: null,
      now: new Date(Date.now() + 1_000),
      leaseMs: 3_600_000,
      maxConnected: 10,
      maxConnectedPerOwner: 10,
    });
    const list = (await app.inject({ method: "GET", url: "/v1/shares", headers: as("alice") })).json();
    expect(list.shares).toHaveLength(3);
    expect(list.shares[0]).toMatchObject({ id: live, name: "live", application: "A", connected: true });
    expect(list.shares.map((s: { connected: boolean }) => s.connected)).toEqual([true, false, false]);
    expect(list.shares.map((s: { id: string }) => s.id)).toContain(idle);
  });

  it("deletes a share with 204, and answers an unknown, deleted or foreign id with one 404", async () => {
    const { app } = await boot();
    const id = (await app.inject({ method: "POST", url: "/v1/shares", headers: as("alice"), payload: { name: "a", application: "A" } })).json().id;
    const foreign = await app.inject({ method: "DELETE", url: `/v1/shares/${id}`, headers: as("bob") });
    const unknown = await app.inject({ method: "DELETE", url: "/v1/shares/nope", headers: as("alice") });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: "share_not_found", message: `no share ${id}` });
    expect(unknown.json()).toEqual({ error: "share_not_found", message: "no share nope" });
    const deleted = await app.inject({ method: "DELETE", url: `/v1/shares/${id}`, headers: as("alice") });
    expect([deleted.statusCode, deleted.body]).toEqual([204, ""]);
    expect((await app.inject({ method: "DELETE", url: `/v1/shares/${id}`, headers: as("alice") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/shares", headers: as("alice") })).json()).toEqual({ shares: [] });
  });

  it("advertises features.shares only when shares are on", async () => {
    const on = await boot({ maxPerOwner: 4 });
    expect((await on.app.inject({ url: "/v1/capabilities" })).json().features.shares).toEqual({
      maxPerOwner: 4,
      maxConnectedPerOwner: 3,
      retentionSeconds: 604_800,
    });
    expect(on.booted.server.shareRetention).toBeInstanceOf(ShareRetention);
    const off = await boot({ shares: false });
    expect((await off.app.inject({ url: "/v1/capabilities" })).json().features).not.toHaveProperty("shares");
    expect((await off.app.inject({ method: "GET", url: "/v1/shares", headers: as("alice") })).statusCode).toBe(404);
  });
});

describe("booting with shares on", () => {
  const boots = async (deps: Parameters<typeof bootTestServer>[0]) => {
    const handle = await temporaryStore();
    try {
      await bootTestServer(deps, handle);
    } finally {
      await handle.dispose();
    }
  };
  const sharesOn = (overrides: Partial<ReturnType<typeof testConfig>> = {}) =>
    testConfig({ identity: IDENTITY, shares: { ...testConfig().shares, enabled: true }, ...overrides });

  it("refuses a backend that routes no shares", async () => {
    const shares = new MemoryShareStore();
    const handle = await temporaryStore();
    try {
      await expect(
        bootTestServer({ config: sharesOn(), store: withShares(handle.store, shares) }, handle),
      ).rejects.toThrow(/^RUNNER_SHARES is on, but this runner's backend routes no shares/);
    } finally {
      await handle.dispose();
    }
  });

  it("refuses a store that holds no shares, naming the store setting", async () => {
    await expect(
      boots({ backend: new FakeWorkloadBackend({ shareRouting: TEST_SHARE_ROUTING }), config: sharesOn() }),
    ).rejects.toThrow(/^RUNNER_SHARES needs RUNNER_SESSION_STORE=postgres/);
  });

  it("refuses a runner with no identity, naming the identity settings", async () => {
    const shares = new MemoryShareStore();
    const handle = await temporaryStore();
    try {
      await expect(
        bootTestServer(
          {
            backend: new FakeWorkloadBackend({ shareRouting: TEST_SHARE_ROUTING }),
            config: sharesOn({ identity: undefined }),
            store: withShares(handle.store, shares),
          },
          handle,
        ),
      ).rejects.toThrow(/^RUNNER_SHARES needs RUNNER_IDENTITY_AUDIENCE and RUNNER_IDENTITY_ISSUERS/);
    } finally {
      await handle.dispose();
    }
  });
});
