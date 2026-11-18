import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareTunnel, ShareTunnelEnding, ShareTunnelOptions, SharePort } from "@telorun/share-tunnel";

import { main } from "../src/cli.js";
import { run, type RunArgv } from "../src/commands/run.js";
import { createLogger } from "../src/logger.js";
import { Output, installOutput } from "../src/output.js";
import { defaultCliServices, type StartShareTunnel } from "../src/share/cli-services.js";
import { userAppDirectory } from "../src/desktop/desktop-app-directory.js";
import { SHARE_NAMES_FILE } from "../src/share/share-names.js";
import { resolveRunnerUrl } from "../src/share/share-runner-url.js";
import { ShareSession } from "../src/share/share-session.js";
import { takeShare } from "../src/share/take-share.js";
import { RunnerSignIn } from "../src/sign-in/runner-sign-in.js";
import { terminalSignInOffer } from "../src/sign-in/sign-in-offer.js";
import { FakeRunner, runnerIdentity, TestCredentialProvider } from "./__fixtures__/share/fake-runner.js";
import { FakeAccounts } from "./__fixtures__/sign-in/fake-accounts.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/share");
const APP = path.join(FIXTURES, "app");
const SHARE = {
  id: "k3xqz2m7ahc4",
  application: "WebhookDemo",
  publicUrlTemplate: "https://{port}-k3xqz2m7ahc4.telorun.test",
  publicUrlSecondaryTemplate: "https://{label}--{port}-k3xqz2m7ahc4.telorun.test",
  tunnelUrl: "wss://tunnel.telorun.test/v1/shares/k3xqz2m7ahc4/tunnel",
};
const LIMITS = { maxPerOwner: 10, maxConnectedPerOwner: 3, retentionSeconds: 604800 };
const HOST_VALUES = ["TELO_HOST_PUBLIC_URL_TEMPLATE", "TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE"];

/** A tunnel the test drives: the ports it was told, and when and how it ends. */
function fakeTunnel() {
  const started: ShareTunnelOptions[] = [];
  const ports: SharePort[][] = [];
  const endings: Array<(ending: ShareTunnelEnding) => void> = [];
  const startTunnel: StartShareTunnel = (options) => {
    started.push(options);
    const ended = new Promise<ShareTunnelEnding>((resolve) => endings.push(resolve));
    const tunnel: ShareTunnel = {
      setPorts: (next) => void ports.push([...next]),
      close: async () => endings.forEach((end) => end({ outcome: "closed" })),
      ended,
    };
    return tunnel;
  };
  return {
    started,
    ports,
    end: (ending: ShareTunnelEnding) => endings.forEach((end) => end(ending)),
    startTunnel,
    loadTunnel: async () => startTunnel,
  };
}

let stderr: string[];
let restoreOutput: () => void;
let state: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  stderr = [];
  restoreOutput = installOutput(
    new Output({ format: "text", stdout: { write: () => true }, stderr: { write: (c: string) => stderr.push(c) }, env: {} }),
  );
  state = fs.mkdtempSync(path.join(os.tmpdir(), "telo-share-"));
  for (const name of ["XDG_DATA_HOME", "HOME", "LOCALAPPDATA", "TELO_NEED_SITE__URL", "TELO_RUNNER_URL", "TELO_ACCOUNTS_URL", ...HOST_VALUES]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env.XDG_DATA_HOME = state;
  process.env.HOME = state;
  process.env.LOCALAPPDATA = state;
  process.exitCode = undefined;
});

afterEach(() => {
  restoreOutput();
  for (const [name, value] of saved) value === undefined ? delete process.env[name] : (process.env[name] = value);
  fs.rmSync(state, { recursive: true, force: true });
  process.exitCode = undefined;
});

const text = () => stderr.join("");
const runArgv = (extra: Partial<RunArgv>): RunArgv => ({
  path: APP,
  verbose: false,
  debug: false,
  open: true,
  watch: false,
  cacheWrite: false,
  input: false,
  ...extra,
});

async function sharingRunner(onShare?: (name: string) => void) {
  return FakeRunner.start({
    shares: LIMITS,
    respond: (request) => {
      if (request.method !== "POST" || request.url !== "/v1/shares") return undefined;
      const { name } = request.body as { name: string };
      onShare?.(name);
      return { status: 201, body: { ...SHARE, name } };
    },
  });
}

describe("telo run --share before boot", () => {
  it("refuses a runner that offers no shares before it asks for any credential", async () => {
    const runner = await FakeRunner.start();
    const credentials = new TestCredentialProvider();
    const taken = await takeShare({ manifest: APP, name: "", runner: runner.url, env: process.env, services: { ...defaultCliServices(), credentials }, log: createLogger(false) });
    await runner.close();
    expect(taken).toBe("refused");
    expect(credentials.requests).toEqual([]);
    expect(text()).toContain(`ERR_SHARE_RUNNER_UNSUPPORTED: ${runner.url} offers no shares`);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a root declaring Telo.DesktopHost", async () => {
    const taken = await takeShare({ manifest: path.join(FIXTURES, "desktop"), name: "", runner: undefined, env: process.env, services: defaultCliServices(), log: createLogger(false) });
    expect(taken).toBe("refused");
    expect(text()).toContain("ERR_SHARE_APP_UNSUPPORTED: Hello declares Telo.DesktopHost, whose window admission answers every visitor 403");
  });

  it("refuses a root with no tcp port", async () => {
    const taken = await takeShare({ manifest: path.join(FIXTURES, "no-ports"), name: "", runner: undefined, env: process.env, services: defaultCliServices(), log: createLogger(false) });
    expect(taken).toBe("refused");
    expect(text()).toContain("ERR_SHARE_APP_UNSUPPORTED: CliTool declares no tcp port");
  });

  it.each(HOST_VALUES)("refuses a run with %s set", async (name) => {
    process.env[name] = "https://{label}.dev.acme.test";
    const taken = await takeShare({ manifest: APP, name: "", runner: undefined, env: process.env, services: defaultCliServices(), log: createLogger(false) });
    expect(taken).toBe("refused");
    expect(text()).toContain(`ERR_SHARE_HOST_VALUE_CONFLICT: ${name} is set; --share is the host of this run's public addresses`);
  });

  it("answers sign-in required with the default wiring, naming the command", async () => {
    const runner = await FakeRunner.start({ shares: LIMITS });
    const taken = await takeShare({ manifest: APP, name: "", runner: runner.url, env: process.env, services: defaultCliServices(), log: createLogger(false) });
    await runner.close();
    expect(taken).toBe("refused");
    expect(text()).toContain(`ERR_RUNNER_SIGN_IN_REQUIRED: sharing needs a sign-in to ${runner.url}\n  run: telo auth login --runner ${runner.url}\n`);
  });

  it("offers to sign in at a terminal, and creates the share once signed in, before any kernel is built", async () => {
    const accounts = await FakeAccounts.start();
    process.env.TELO_ACCOUNTS_URL = accounts.url;
    const identified = await FakeRunner.start({
      shares: LIMITS,
      identity: (url) => runnerIdentity(url, accounts.url),
      respond: (request) => (request.method === "POST" && request.url === "/v1/shares" ? { status: 201, body: { ...SHARE, name: "demo" } } : undefined),
    });
    const signIn = new RunnerSignIn({
      env: { TELO_ACCOUNTS_URL: accounts.url, DISPLAY: ":0" },
      directory: path.join(state, "sign-in"),
      signInCommand: () => "telo auth login",
      openBrowser: (url) => void fetch(url).then((response) => response.text()),
    });
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdin.write("\n");
    const services = { ...defaultCliServices(), signIn, credentials: signIn, loadTunnel: fakeTunnel().loadTunnel };

    const taken = await takeShare({
      manifest: APP,
      name: "demo",
      runner: identified.url,
      env: process.env,
      services,
      log: createLogger(false),
      offer: terminalSignInOffer({ stdin: stdin as unknown as NodeJS.ReadStream, stderr: { isTTY: true } }),
    });
    const created = identified.requests.find((request) => request.method === "POST");
    await identified.close();
    await accounts.close();

    expect(text()).toContain("Sign in to Telo now? [Y/n] ");
    expect(text()).toContain(`Signed in to ${accounts.url} as alice`);
    expect(taken).toBeInstanceOf(ShareSession);
    expect(created!.headers.authorization).toMatch(/^DPoP /);
    expect(process.exitCode).toBeUndefined();
    await (taken as ShareSession).close();
  });

  it("refuses with the provider's own words when it cannot answer", async () => {
    const runner = await FakeRunner.start({ shares: LIMITS });
    const credentials = { credential: async () => ({ outcome: "unavailable" as const, message: "the token endpoint answered 503" }) };
    const taken = await takeShare({ manifest: APP, name: "", runner: runner.url, env: process.env, services: { ...defaultCliServices(), credentials }, log: createLogger(false) });
    await runner.close();
    expect(taken).toBe("refused");
    expect(text()).toMatch(/error: the token endpoint answered 503\n$/);
  });

  it("surfaces the runner's own refusal of a share", async () => {
    const runner = await FakeRunner.start({
      shares: LIMITS,
      respond: () => ({ status: 429, body: { error: "too_many_shares", message: "this runner keeps at most 10 shares per owner; delete one with telo shares delete <id>" } }),
    });
    const services = { ...defaultCliServices(), credentials: new TestCredentialProvider() };
    const taken = await takeShare({ manifest: APP, name: "", runner: runner.url, env: process.env, services, log: createLogger(false) });
    await runner.close();
    expect(taken).toBe("refused");
    expect(text()).toContain("too_many_shares: this runner keeps at most 10 shares per owner");
  });

  it("refuses --share-runner without --share as a usage error", () => {
    // The parser's middleware swaps the ambient Output for one over the process streams.
    const written: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => written.push(chunk)) as never);
    try {
      main(["run", "--share-runner", "https://runner.acme.internal", APP]);
    } finally {
      write.mockRestore();
    }
    expect(process.exitCode).toBe(2);
    expect(written.join("")).toMatch(/--share-runner needs --share\n$/);
  });

  it("chooses the runner by flag, then TELO_RUNNER_URL, then the hosted one", () => {
    expect(resolveRunnerUrl("https://flag.test/", { TELO_RUNNER_URL: "https://env.test" })).toBe("https://flag.test");
    expect(resolveRunnerUrl(undefined, { TELO_RUNNER_URL: "https://env.test" })).toBe("https://env.test");
    expect(resolveRunnerUrl(undefined, {})).toBe("https://runner.telo.run");
  });
});

describe("telo run --share", () => {
  // First among the runs: once a kernel has booted in this process, it hides every need variable from `process.env`.
  it("lists a Telo.PublicUrl the environment sets as not shared, and keeps its value", async () => {
    process.env.TELO_NEED_SITE__URL = "https://hooks.acme.test";
    const runner = await sharingRunner();
    const services = { ...defaultCliServices(), credentials: new TestCredentialProvider(), loadTunnel: fakeTunnel().loadTunnel };
    await run(runArgv({ share: "", shareRunner: runner.url }), services);
    await runner.close();
    expect(text()).toContain(
      [
        "  http   8080      https://8080-k3xqz2m7ahc4.telorun.test",
        "  admin  9090      https://9090-k3xqz2m7ahc4.telorun.test",
        "  stats  8125/udp  not shared: udp",
        "  site             https://hooks.acme.test                 not shared: set by TELO_NEED_SITE__URL",
      ].join("\n"),
    );
  }, 60_000);

  it("boots with the share's templates as host values, signs each request, and prints what is shared", async () => {
    const names: string[] = [];
    const runner = await sharingRunner((name) => names.push(name));
    const tunnel = fakeTunnel();
    const credentials = new TestCredentialProvider();
    await run(runArgv({ share: "", shareRunner: runner.url }), { ...defaultCliServices(), credentials, loadTunnel: tunnel.loadTunnel });
    await runner.close();

    expect(text()).toContain(
      [
        `Shared through ${runner.url} (share k3xqz2m7ahc4):`,
        "  http   8080      https://8080-k3xqz2m7ahc4.telorun.test  site",
        "  admin  9090      https://9090-k3xqz2m7ahc4.telorun.test",
        "  stats  8125/udp  not shared: udp",
      ].join("\n"),
    );
    expect(tunnel.started[0]).toMatchObject({ tunnelUrl: SHARE.tunnelUrl, runnerUrl: runner.url });
    expect(tunnel.ports).toEqual([[{ name: "http", port: 8080 }, { name: "admin", port: 9090 }]]);

    const [capabilities, created] = runner.requests;
    expect(capabilities!.headers.authorization).toBeUndefined();
    expect(created!.body).toEqual({ name: names[0], application: "WebhookDemo" });
    expect(names[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(created!.headers.authorization).toBe("DPoP test-access-token");
    const proof = JSON.parse(Buffer.from(String(created!.headers.dpop).split(".")[1]!, "base64url").toString());
    expect(proof).toMatchObject({ htm: "POST", htu: `${runner.url}/v1/shares` });
  }, 60_000);

  it("mints one name per real manifest path, and sends --share=<name> as given", async () => {
    const names: string[] = [];
    const runner = await sharingRunner((name) => names.push(name));
    const services = { ...defaultCliServices(), credentials: new TestCredentialProvider(), loadTunnel: fakeTunnel().loadTunnel };
    const copy = path.join(state, "copy");
    fs.cpSync(APP, copy, { recursive: true });
    const take = (manifest: string, name: string) =>
      takeShare({ manifest, name, runner: runner.url, env: process.env, services, log: createLogger(false) });
    for (const [manifest, name] of [[APP, ""], [APP, ""], [copy, ""], [APP, "demo"]] as const) {
      const taken = await take(manifest, name);
      expect(taken).not.toBe("refused");
      for (const host of HOST_VALUES) delete process.env[host];
    }
    await runner.close();
    expect(names[0]).toBe(names[1]);
    expect(names[2]).not.toBe(names[0]);
    expect(names[3]).toBe("demo");
    const kept = JSON.parse(fs.readFileSync(path.join(userAppDirectory("telo") ?? "", SHARE_NAMES_FILE), "utf8")) as Record<string, string>;
    expect(Object.values(kept).sort()).toEqual([names[0], names[2]].sort());
  }, 60_000);

  it("ends the run with status 1 when the share is lost", async () => {
    const runner = await sharingRunner();
    const tunnel = fakeTunnel();
    const services = {
      ...defaultCliServices(),
      credentials: new TestCredentialProvider(),
      loadTunnel: async (): Promise<StartShareTunnel> => (options) => {
        const started = tunnel.startTunnel(options);
        queueMicrotask(() => tunnel.end({ outcome: "lost", reason: "superseded", code: 4409, detail: "" }));
        return started;
      },
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await expect(run(runArgv({ share: "", shareRunner: runner.url }), services)).rejects.toThrow("exit 1");
    } finally {
      exit.mockRestore();
      await runner.close();
    }
    expect(text()).toContain("ERR_SHARE_LOST: share k3xqz2m7ahc4 was taken over by another run");
  }, 60_000);
});

describe("the share session", () => {
  const kernelOf = (ports: Array<{ name: string; port: number; protocol?: "tcp" | "udp" }>) => ({
    getResolvedPorts: () => ports.map((port) => ({ protocol: "tcp" as const, ...port })),
  });

  it("announces the ports on every load and prints only what a reload added", () => {
    const tunnel = fakeTunnel();
    const session = new ShareSession({ ...SHARE, name: "n" }, "https://runner.test", LIMITS, { credentials: new TestCredentialProvider(), startTunnel: tunnel.startTunnel });
    session.loaded(kernelOf([{ name: "http", port: 8080 }]));
    session.loaded(kernelOf([{ name: "http", port: 8080 }, { name: "metrics", port: 9100 }]));
    expect(tunnel.ports).toEqual([[{ name: "http", port: 8080 }], [{ name: "http", port: 8080 }, { name: "metrics", port: 9100 }]]);
    expect(text()).toBe(
      [
        "Shared through https://runner.test (share k3xqz2m7ahc4):",
        "  http  8080  https://8080-k3xqz2m7ahc4.telorun.test",
        "Reloaded: now also sharing",
        "  metrics  9100  https://9100-k3xqz2m7ahc4.telorun.test",
        "",
      ].join("\n"),
    );
  });

  it("words the tunnel's warnings, and says when the share is back", () => {
    const tunnel = fakeTunnel();
    new ShareSession({ ...SHARE, name: "n" }, "https://runner.test", LIMITS, { credentials: new TestCredentialProvider(), startTunnel: tunnel.startTunnel });
    const emit = tunnel.started[0]!.onEvent!;
    emit({ type: "warning", reason: "credential-refused", detail: "", code: 4401 });
    emit({ type: "connected", epoch: 1, reconnect: true, afterWarning: true });
    emit({ type: "warning", reason: "owner-limit", detail: "", code: 4429 });
    emit({ type: "warning", reason: "runner-capacity", detail: "", code: 4503 });
    emit({ type: "connected", epoch: 1, reconnect: true, afterWarning: true });
    expect(text()).toBe(
      [
        "warning: https://runner.test refused the share's credential; visitors get 503 until you run:",
        "  telo auth login --runner https://runner.test",
        "Share k3xqz2m7ahc4 reconnected.",
        "warning: you already have 3 shares connected on https://runner.test; retrying (visitors get 503 meanwhile)",
        "warning: https://runner.test is at its connected-share capacity; retrying (visitors get 503 meanwhile)",
        "Share k3xqz2m7ahc4 reconnected.",
        "",
      ].join("\n"),
    );
  });

  it("turns a relay with no generation we offer into ERR_SHARE_RUNNER_UNSUPPORTED", async () => {
    const tunnel = fakeTunnel();
    const session = new ShareSession({ ...SHARE, name: "n" }, "https://runner.test", LIMITS, { credentials: new TestCredentialProvider(), startTunnel: tunnel.startTunnel });
    const refusals: string[] = [];
    session.onFailure((refusal) => refusals.push(`${refusal.refusalCode}: ${refusal.message}`));
    tunnel.end({ outcome: "runner-unsupported", offered: ["telo-share-1"], cause: "no-subprotocol", detail: "" });
    await Promise.resolve();
    await Promise.resolve();
    expect(refusals).toEqual(["ERR_SHARE_RUNNER_UNSUPPORTED: https://runner.test speaks no tunnel generation this telo offers (telo-share-1)"]);
  });

  it("words a protocol error as one and carries the cause, never a generation mismatch", async () => {
    const tunnel = fakeTunnel();
    const session = new ShareSession({ ...SHARE, name: "n" }, "https://runner.test", LIMITS, { credentials: new TestCredentialProvider(), startTunnel: tunnel.startTunnel });
    let lines: string[] = [];
    session.onFailure((refusal) => (lines = refusal.lines("error")));
    tunnel.end({ outcome: "runner-unsupported", offered: ["telo-share-1"], cause: "protocol-error", detail: "a binary message over 1048576 bytes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(lines).toEqual([
      "error ERR_SHARE_RUNNER_UNSUPPORTED: the tunnel to https://runner.test ended on a protocol error",
      "  a binary message over 1048576 bytes",
    ]);
  });

  it("warns once per distinct local forwarding failure until the port answers again", () => {
    const tunnel = fakeTunnel();
    new ShareSession({ ...SHARE, name: "n" }, "https://runner.test", LIMITS, { credentials: new TestCredentialProvider(), startTunnel: tunnel.startTunnel });
    const emit = tunnel.started[0]!.onEvent!;
    emit({ type: "forward-failed", port: 8080, message: "connect ECONNREFUSED 127.0.0.1:8080" });
    emit({ type: "forward-failed", port: 8080, message: "connect ECONNREFUSED 127.0.0.1:8080" });
    emit({ type: "forward-failed", port: 8080, message: "Parse Error" });
    emit({ type: "forward-recovered", port: 8080 });
    emit({ type: "forward-failed", port: 8080, message: "Parse Error" });
    expect(text()).toBe(
      [
        "warning: share k3xqz2m7ahc4: port 8080: connect ECONNREFUSED 127.0.0.1:8080",
        "warning: share k3xqz2m7ahc4: port 8080: Parse Error",
        "warning: share k3xqz2m7ahc4: port 8080: Parse Error",
        "",
      ].join("\n"),
    );
  });
});
