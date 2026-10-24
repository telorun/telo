import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildServer,
  loadCoreConfig,
  openSessionStore,
  type SessionStore,
} from "@telorun/runner-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localRunnerCapabilities, validateLocalRunnerConfig } from "../src/runner/capabilities.js";
import { createProcessBackend } from "../src/runner/process-backend.js";
import { prepareStateRoot, sessionDirectory } from "../src/runner/state-root.js";
import { createTeloSupply } from "../src/runner/telo-supply.js";

/**
 * What `telo runner` promises over the wire, checked at the routes: a client
 * reads `/v1/capabilities` and the runner enforces exactly that, and a session
 * is a directory kept by id across suspends and runner restarts. A Run spawns
 * a stand-in for telo that records its argv, cwd and env and stays up.
 */

const FAKE_TELO = path.join(import.meta.dirname, "__fixtures__", "runner-fake-telo", "fake-telo.mjs");

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let store: SessionStore;
let stateRoot: string;
/** What the release host answers, by URL suffix; anything else is a 404. */
let release: Record<string, { status: number; body: string }>;

async function boot(): Promise<void> {
  await prepareStateRoot(stateRoot);
  const base = loadCoreConfig({}, { port: 8061, stateDir: stateRoot });
  store = await openSessionStore(base.sessionStore, { log: { error: () => undefined } });
  const built = await buildServer({
    backend: createProcessBackend({
      stateRoot,
      self: async () => ({ command: process.execPath, prefix: [FAKE_TELO], env: {} }),
      telo: createTeloSupply({
        identity: "0.50.0+unreleased",
        hostTarget: "linux-amd64-gnu",
        cacheRoot: path.join(stateRoot, "binaries"),
        fetch: async (input) => {
          const url = String(input);
          const hit = Object.entries(release).find(([suffix]) => url.endsWith(suffix));
          return new Response(hit?.[1].body ?? "", { status: hit?.[1].status ?? 404 });
        },
      }),
    }),
    config: {
      ...base,
      logLevel: "silent",
      // What `telo runner` serves: no browser origin unless one was named.
      corsOrigins: [],
    },
    store,
    version: "test",
    capabilities: localRunnerCapabilities(),
    validateConfig: validateLocalRunnerConfig,
  });
  app = built.app;
  await app.ready();
}

/** The runner process ending: every run ends, the directories stay. */
async function shutDown(): Promise<void> {
  await app.close();
  await store.close();
}

beforeEach(async () => {
  stateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-runner-test-")));
  release = {};
  await boot();
});

afterEach(async () => {
  await shutDown();
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

interface Session {
  id: string;
  auth: { authorization: string };
}

async function create(payload: Record<string, unknown>): Promise<Session> {
  const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { workspace: "ws", ...payload } });
  expect(res.statusCode).toBe(201);
  const { sessionId, resumeSecret } = res.json() as { sessionId: string; resumeSecret: string };
  return { id: sessionId, auth: { authorization: `Bearer ${resumeSecret}` } };
}

async function document(session: Session): Promise<Record<string, any>> {
  return (await app.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers: session.auth })).json();
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never reached the expected state: ${JSON.stringify(await read())}`);
}

const statusOf = (session: Session, kind: string) =>
  until(() => document(session), (doc) => doc.status?.kind === kind);

async function seed(session: Session, files: Record<string, string>): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.id}/workspace`,
    headers: session.auth,
    payload: { write: Object.entries(files).map(([p, content]) => ({ path: p, content })) },
  });
  expect(res.statusCode).toBe(200);
}

const run = (session: Session, appName: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/v1/sessions/${session.id}/apps/${appName}/run`,
    headers: session.auth,
    payload: body,
  });

describe("telo runner capabilities", () => {
  it("advertises streams-only io, no editable config and no co-resident agent", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      config: { schema: { properties: {} } },
      features: { io: ["streams"], ports: true, teloVersions: true },
    });
    expect(body.features.agents).toBeUndefined();
    expect(body.features.watch).toBeUndefined();
  });

  it("reports ready without a config, because it has none to check", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/probe", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });
});

describe("a session's directory", () => {
  it("is kept by id across suspend and a runner restart, and resumed from", async () => {
    const session = await create({ apps: [{ name: "a", entryRelativePath: "a.yaml" }] });
    await statusOf(session, "running");
    await seed(session, { "a.yaml": "kind: Telo.Application\n" });

    const dir = sessionDirectory(stateRoot, session.id);
    for (const level of [dir.root, dir.workspace, dir.agent]) {
      // Windows keeps no POSIX mode bits.
      if (process.platform !== "win32") expect(fs.statSync(level).mode & 0o777).toBe(0o700);
    }

    await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/suspend`, headers: session.auth });
    await statusOf(session, "suspended");
    expect(fs.existsSync(path.join(dir.workspace, "a.yaml"))).toBe(true);

    await shutDown();
    await boot();
    expect((await document(session)).status.kind).toBe("suspended");

    await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/resume`, headers: session.auth });
    await statusOf(session, "running");
    const tree = (
      await app.inject({ method: "GET", url: `/v1/sessions/${session.id}/workspace`, headers: session.auth })
    ).json() as { files: Array<{ path: string }> };
    expect(tree.files.map((f) => f.path)).toEqual(["a.yaml", "telo-workspace.yaml"]);
  });

  it("is suspended, not lost, when the runner restarts while it runs", async () => {
    const session = await create({ apps: [] });
    await statusOf(session, "running");
    await shutDown();
    await boot();
    expect((await document(session)).status.kind).toBe("suspended");
    expect(fs.existsSync(sessionDirectory(stateRoot, session.id).workspace)).toBe(true);
  });

  it("is spared by the boot sweep, which removes only directories no stored session owns", async () => {
    const session = await create({ apps: [] });
    await statusOf(session, "running");
    const stray = sessionDirectory(stateRoot, "strayleftover");
    fs.mkdirSync(stray.workspace, { recursive: true });

    await shutDown();
    await boot();
    expect(fs.existsSync(stray.root)).toBe(false);
    expect(fs.existsSync(sessionDirectory(stateRoot, session.id).root)).toBe(true);
  });

  it("goes with the session when it is deleted", async () => {
    const session = await create({ apps: [] });
    await statusOf(session, "running");
    const res = await app.inject({ method: "DELETE", url: `/v1/sessions/${session.id}`, headers: session.auth });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(sessionDirectory(stateRoot, session.id).root)).toBe(false);
  });
});

describe("a run", () => {
  it("is core's argv in the session workspace, and its env reaches only the process it starts", async () => {
    const session = await create({
      apps: [
        { name: "a", entryRelativePath: "a.yaml" },
        { name: "b", entryRelativePath: "b.yaml" },
      ],
    });
    await statusOf(session, "running");
    await seed(session, { "a.yaml": "", "b.yaml": "" });
    expect((await run(session, "a", { env: { RUN_PROBE: "for-a" }, io: "streams" })).statusCode).toBe(202);
    expect((await run(session, "b", { env: {}, io: "streams" })).statusCode).toBe(202);

    const workspace = sessionDirectory(stateRoot, session.id).workspace;
    const seen = (entry: string) =>
      until(
        async () => {
          const file = path.join(workspace, `${entry}.seen.json`);
          return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
        },
        (value) => value !== undefined,
      );
    const a = await seen("a.yaml");
    const b = await seen("b.yaml");
    expect(a.argv.slice(0, 4)).toEqual(["run", "--watch", "--no-input", "--inspect"]);
    expect(a.argv.slice(-2)).toEqual(["--no-open", "a.yaml"]);
    expect(fs.realpathSync(a.cwd)).toBe(workspace);
    expect(a.probe).toBe("for-a");
    expect(b.probe).toBeNull();
    expect(process.env.RUN_PROBE).toBeUndefined();

    const appState = (name: string) =>
      until(
        () => document(session),
        (doc) => doc.apps.find((x: { name: string }) => x.name === name)?.state === "ready",
      );
    expect((await document(session)).apps.find((x: { name: string }) => x.name === "a").state).toBe("running");
    await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/apps/a/stop`, headers: session.auth });
    await appState("a");
  });

  it("refuses an explicit tty rather than downgrading it silently", async () => {
    const session = await create({ apps: [{ name: "a", entryRelativePath: "a.yaml" }] });
    await statusOf(session, "running");
    const res = await run(session, "a", { env: {}, io: "tty" });
    // `isatty()` is observable to the application, so a run claiming a
    // terminal it does not have is the one outcome worth refusing.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "io_unsupported" });
    expect(res.json().message).toMatch(/streams/);
  });
});

describe("an application naming its telo version", () => {
  const asking = (telo: string) =>
    app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspace: "ws", apps: [{ name: "app", entryRelativePath: "telo.yaml", telo }] },
    });

  /** The session's status message once its start has settled as a failure. */
  async function failedStart(telo: string): Promise<string> {
    const res = await asking(telo);
    expect(res.statusCode).toBe(201);
    const { sessionId, resumeSecret } = res.json() as { sessionId: string; resumeSecret: string };
    const doc = await statusOf({ id: sessionId, auth: { authorization: `Bearer ${resumeSecret}` } }, "failed");
    return doc.status.message ?? "";
  }

  // What is certain without the network is refused before a session exists.
  it("refuses another build's unreleased identity, which no release can stand in for", async () => {
    const res = await asking("0.123.0+unreleased");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "telo_version_unavailable", app: "app", version: "0.123.0+unreleased" });
    expect(res.json().reason).toMatch(/unreleased build, which only the build it came from can run/);
    expect(res.json().reason).toMatch(/Pin a released telo version/);
  });

  it("refuses text that is not a version before asking for anything", async () => {
    const res = await asking("latest");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_telo_version" });
  });

  // A release this machine does not hold is fetched by the workload's
  // creation, so its failure is that session's — carrying the same reason.
  it("fails the start for a release that publishes no binary, naming the version and the cause", async () => {
    expect(await failedStart("0.123.0")).toMatch(
      /telo 0\.123\.0 publishes no binary for linux-amd64-gnu \(HTTP 404/,
    );
  });

  it("fails the start for a download the release host fails, with its status", async () => {
    release["telo-0.123.0-linux-amd64-gnu.tar.gz"] = { status: 503, body: "" };
    expect(await failedStart("0.123.0")).toMatch(/HTTP 503/);
  });

  it("fails the start for a binary the release publishes no checksum for", async () => {
    release["telo-0.123.0-linux-amd64-gnu.tar.gz"] = { status: 200, body: "bytes" };
    expect(await failedStart("0.123.0")).toMatch(/no checksums\.txt published/);
  });

  it("fails the start for a binary whose checksum does not match", async () => {
    release["telo-0.123.0-linux-amd64-gnu.tar.gz"] = { status: 200, body: "bytes" };
    release["checksums.txt"] = { status: 200, body: `${"0".repeat(64)}  telo-0.123.0-linux-amd64-gnu.tar.gz\n` };
    expect(await failedStart("0.123.0")).toMatch(/checksum mismatch/);
  });
});

describe("browser origins", () => {
  it("refuses a request from an origin it was not given", async () => {
    // Every page the user visits can reach 127.0.0.1, and this API runs code —
    // so an unnamed origin is refused by the runner itself rather than left to
    // the browser's own CORS rule.
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { origin: "https://evil.example" },
      payload: { workspace: "ws", apps: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "origin_not_allowed" });
  });

  it("leaves a request with no Origin alone", async () => {
    // A CLI, a script or a health check sends none; what bounds those is the
    // loopback bind, not this.
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("session config", () => {
  it("refuses a config key it advertises no room for", async () => {
    // The closed schema on /v1/capabilities constrains the editor; this is what
    // holds a client that skipped it to the same answer.
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspace: "ws", apps: [], config: { image: "telorun/node:0-slim" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_config" });
    expect(res.json().message).toMatch(/image/);
  });
});
