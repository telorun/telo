import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSharesDelete, runSharesList } from "../src/commands/shares.js";
import { Output, installOutput } from "../src/output.js";
import { defaultCliServices } from "../src/share/cli-services.js";
import { FakeRunner, runnerIdentity, TestCredentialProvider } from "./__fixtures__/share/fake-runner.js";

const LIMITS = { maxPerOwner: 10, maxConnectedPerOwner: 3, retentionSeconds: 604800 };
const SHARES = [
  { id: "p7d2wqe4r6tb", name: "demo", application: "WebhookDemo", connected: true, lastActiveAt: "2026-11-13T10:42:07Z" },
  { id: "k3xqz2m7ahc4", name: "6f1c2a9e-4b7d-4e0a-9c3f-2d8e5b1a7c40", application: "WebhookDemo", connected: false, lastActiveAt: "2026-11-13T10:41:15Z" },
];

let stdout: string[];
let stderr: string[];
let restore: () => void;
let state: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  // The default wiring reads the sign-in store of telo's per-user state directory.
  state = fs.mkdtempSync(path.join(os.tmpdir(), "telo-shares-"));
  for (const name of ["XDG_DATA_HOME", "HOME", "LOCALAPPDATA", "TELO_ACCOUNTS_URL", "TELO_RUNNER_URL"]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env.XDG_DATA_HOME = state;
  process.env.HOME = state;
  process.env.LOCALAPPDATA = state;
  stdout = [];
  stderr = [];
  restore = installOutput(
    new Output({ format: "text", stdout: { write: (c: string) => stdout.push(c) }, stderr: { write: (c: string) => stderr.push(c) }, env: {} }),
  );
  process.exitCode = undefined;
});

afterEach(() => {
  restore();
  for (const [name, value] of saved) value === undefined ? delete process.env[name] : (process.env[name] = value);
  fs.rmSync(state, { recursive: true, force: true });
  process.exitCode = undefined;
});

const signedIn = () => ({ ...defaultCliServices(), credentials: new TestCredentialProvider() });

describe("telo shares", () => {
  it("lists the caller's shares as a table, signing the request", async () => {
    const runner = await FakeRunner.start({ shares: LIMITS, respond: (r) => (r.method === "GET" && r.url === "/v1/shares" ? { status: 200, body: { shares: SHARES } } : undefined) });
    await runSharesList({ runner: runner.url }, signedIn());
    await runner.close();
    expect(stdout.join("")).toBe(
      [
        "ID            NAME                                  APPLICATION  CONNECTED  LAST ACTIVE",
        "p7d2wqe4r6tb  demo                                  WebhookDemo  yes        2026-11-13T10:42:07Z",
        "k3xqz2m7ahc4  6f1c2a9e-4b7d-4e0a-9c3f-2d8e5b1a7c40  WebhookDemo  no         2026-11-13T10:41:15Z",
        "",
      ].join("\n"),
    );
    expect(runner.requests.at(-1)!.headers.authorization).toBe("DPoP test-access-token");
    expect(process.exitCode).toBeUndefined();
  });

  it("deletes a share, and surfaces the runner's words for an unknown one", async () => {
    const runner = await FakeRunner.start({
      shares: LIMITS,
      respond: (r) =>
        r.method === "DELETE" && r.url === "/v1/shares/k3xqz2m7ahc4"
          ? { status: 204 }
          : { status: 404, body: { error: "share_not_found", message: `no share ${r.url.split("/").pop()}` } },
    });
    await runSharesDelete({ id: "k3xqz2m7ahc4", runner: runner.url }, signedIn());
    expect(stdout.join("")).toBe("Deleted share k3xqz2m7ahc4\n");
    stdout.length = 0;
    await runSharesDelete({ id: "nope", runner: runner.url }, signedIn());
    await runner.close();
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("share_not_found: no share nope");
    expect(process.exitCode).toBe(1);
  });

  it("refuses a runner that offers no shares, for both verbs", async () => {
    const runner = await FakeRunner.start();
    await runSharesList({ runner: runner.url }, signedIn());
    await runSharesDelete({ id: "k3xqz2m7ahc4", runner: runner.url }, signedIn());
    await runner.close();
    const refusal = `ERR_SHARE_RUNNER_UNSUPPORTED: ${runner.url} offers no shares\n`;
    expect(stderr.join("")).toContain(refusal);
    expect(stderr.join("").split(refusal)).toHaveLength(3);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a runner whose advertised identity disagrees, before asking for any credential", async () => {
    const runner = await FakeRunner.start({ shares: LIMITS, identity: (url) => runnerIdentity(url, "https://accounts.acme.test") });
    const credentials = new TestCredentialProvider();
    await runSharesList({ runner: runner.url }, { ...defaultCliServices(), credentials });
    await runner.close();
    expect(credentials.requests).toEqual([]);
    expect(stderr.join("")).toContain(
      `ERR_RUNNER_IDENTITY_MISMATCH: ${runner.url} accepts sign-ins from https://accounts.acme.test, not https://accounts.telo.run (TELO_ACCOUNTS_URL)\n`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("is refused for a sign-in under the default wiring", async () => {
    const runner = await FakeRunner.start({ shares: LIMITS });
    await runSharesList({ runner: runner.url }, defaultCliServices());
    await runner.close();
    expect(stderr.join("")).toContain(`ERR_RUNNER_SIGN_IN_REQUIRED: sharing needs a sign-in to ${runner.url}\n  run: telo auth login --runner ${runner.url}\n`);
  });
});
