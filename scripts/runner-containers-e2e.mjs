#!/usr/bin/env node
// `node scripts/runner-containers-e2e.mjs` — a container-backed integration test,
// unchanged, run in a workspace session over a runner's `/v1`, with the runner
// serving the session its container engine. It drives a session's whole life:
// create (answered with a resume secret every later request carries), seed the
// workspace, Run the test — whose run must complete with exit code 0 — Stop,
// suspend, resume (the seeded files must still be there), delete. The test's own
// containers must be gone once its run ends, and the session's workload once it
// is suspended and once it is deleted.
//
//   node scripts/runner-containers-e2e.mjs [--image <kernel image>]
//       Docker: runs the docker runner's `production` image, built from this
//       tree as `telorun/docker-runner:e2e` — never the development stack's
//       runner or its image tag — configured with only the settings the feature
//       needs, on a loopback port the daemon assigns. It mounts no checkout and
//       writes nothing into it, so a development stack watching the checkout is
//       never restarted by it. It owns, and always removes, its runner, network
//       and bundles and state volumes, all named `telo-runner-e2e…`. The session
//       runs on the kernel image built from this tree (the `kernel` compose
//       service, `telo-dev/node:local`), which this command builds — or on the
//       image `--image` names, which it does not build. A docker
//       runner removes every session container on its daemon that no session it
//       knows is running when it boots — any container named `telo-run-*` or
//       labelled `telo.run/session-id` or `run.telo.session`, whichever runner
//       started it — so this command refuses to run, exiting 1 and naming them,
//       while any such container exists; it removes none itself. The check is
//       taken immediately before its runner starts, so a session started
//       elsewhere during that runner's boot is still taken.
//
//   node scripts/runner-containers-e2e.mjs --kubernetes --runner-url <url> \
//       [--namespace telo-sessions] [--image telo-dev/node:local]
//       Kubernetes: drives a runner already installed from the chart with
//       `session.containers.enabled=true` (the kind job in `e2e.yml`), and checks
//       the session namespace for the session's pods, claim and policies.
//
// The test imports its modules by relative path, and a session has no
// `node_modules` to build a module's controller against, so what is seeded is
// what `telo package` carries: every local module with its controllers built, the
// TypeScript sources left behind. Built bundles are minified (whitespace and
// syntax only) and the seed is sent in change sets under the runner's 1 MiB body
// limit.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { transform } from "esbuild";

const repo = path.resolve(import.meta.dirname, "..");
const TEST = "modules/vector-store-pgvector/tests/integration/filtered-top-k.yaml";
const APP = "test";
const PROJECT = "telo-runner-e2e";
const RUNNER_CONTAINER = `${PROJECT}-runner`;
const RUNNER_NETWORK = `${PROJECT}-network`;
const RUNNER_VOLUME = `${PROJECT}-bundles`;
const STATE_VOLUME = `${PROJECT}-state`;
const RUNNER_IMAGE = "telorun/docker-runner:e2e";
const KERNEL_IMAGE = "telo-dev/node:local";
const RUN_TIMEOUT_MS = 15 * 60_000;
const STEP_TIMEOUT_MS = 5 * 60_000;
/** How many dropped event-stream connections a run reopens before failing. */
const STREAM_RECONNECTS = 20;
const CLEANUP_TIMEOUT_MS = 90_000;
const CHANGE_SET_BYTES = 768 * 1024;

const { values: options } = parseArgs({
  options: {
    kubernetes: { type: "boolean", default: false },
    "runner-url": { type: "string" },
    namespace: { type: "string", default: "telo-sessions" },
    image: { type: "string", default: KERNEL_IMAGE },
  },
});

class E2EFailure extends Error {}

const env = {
  ...process.env,
  PATH: `${path.join(repo, "node_modules", ".bin")}${path.delimiter}${process.env.PATH}`,
};

function describe(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new E2EFailure(`\`${describe(command, args)}\` exited with ${result.status ?? result.signal}`);
  }
}

function read(command, args) {
  const result = spawnSync(command, args, { cwd: repo, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new E2EFailure(
      `\`${describe(command, args)}\` exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

const lines = (text) => text.split("\n").filter(Boolean);
const compose = (...args) => ["compose", "-p", PROJECT, ...args];

/** The test and every local module it reaches, controllers built — through
 *  `telo package`'s own assembly, run by bun from the CLI's sources. */
function packagedTest() {
  const out = mkdtempSync(path.join(os.tmpdir(), "telo-runner-e2e-"));
  const program = `
    const { buildAppPayload } = await import(${JSON.stringify(path.join(repo, "cli/nodejs/src/package/build-app-payload.ts"))});
    const { unpackPayload } = await import(${JSON.stringify(path.join(repo, "cli/nodejs/src/package/app-payload.ts"))});
    const { payload, index } = await buildAppPayload({
      manifestPath: ${JSON.stringify(TEST)},
      platform: { os: "linux", arch: ${JSON.stringify(process.arch === "arm64" ? "arm64" : "amd64")}, libc: "gnu", abi: "node-137" },
      report: (message) => console.error(message),
    });
    await unpackPayload(payload, ${JSON.stringify(out)});
    process.stdout.write(JSON.stringify(index));
  `;
  const index = JSON.parse(read("bun", ["-e", program]));
  return { dir: path.join(out, "app"), entry: index.entry.replace(/^app\//, ""), cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

/** The packaged test as workspace change sets, each under the body limit. */
async function seedOf(app) {
  const sets = [];
  let current = [];
  let size = 0;
  for (const found of readdirSync(app.dir, { recursive: true, withFileTypes: true })) {
    if (!found.isFile()) continue;
    const file = path.join(found.parentPath, found.name);
    let content = readFileSync(file, "utf8");
    if (file.endsWith(".mjs")) {
      content = (await transform(content, { loader: "js", format: "esm", minifyWhitespace: true, minifySyntax: true })).code;
    }
    const write = { path: path.relative(app.dir, file).split(path.sep).join("/"), content };
    const bytes = Buffer.byteLength(JSON.stringify(write));
    if (bytes > CHANGE_SET_BYTES) throw new E2EFailure(`${write.path} alone exceeds a change set (${bytes} bytes)`);
    if (size + bytes > CHANGE_SET_BYTES) {
      sets.push({ write: current });
      current = [];
      size = 0;
    }
    current.push(write);
    size += bytes;
  }
  if (current.length > 0) sets.push({ write: current });
  return { entry: app.entry, sets };
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 180_000;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(1000);
  }
  throw new E2EFailure(`the runner at ${baseUrl} did not become healthy: ${last}`);
}

/** One session over `/v1`, every request carrying its resume secret. */
class Session {
  constructor(baseUrl, id, secret) {
    this.baseUrl = baseUrl;
    this.id = id;
    this.secret = secret;
  }

  async call(method, route, body, expected) {
    const res = await fetch(`${this.baseUrl}/v1/sessions/${this.id}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secret}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status !== expected) {
      throw new E2EFailure(`${method} /v1/sessions/${this.id}${route} answered HTTP ${res.status}: ${await res.text()}`);
    }
    return res.status === 204 ? undefined : res.json();
  }

  /** The session's output, printed as it arrives so a failure shows its cause. */
  async attachOutput(app) {
    const { ticket } = await this.call("POST", "/io-tickets", { app }, 201);
    const socket = new WebSocket(`${this.baseUrl.replace(/^http/, "ws")}/v1/sessions/${this.id}/io?ticket=${ticket}`);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (message) => {
      if (typeof message.data === "string") return;
      process.stderr.write(Buffer.from(message.data).subarray(5));
    });
    return () => socket.close();
  }
}

/** The session's event stream, read once from its start: each `until` takes
 *  the events after the one the previous call returned. */
class EventStream {
  constructor(session) {
    this.abort = new AbortController();
    this.events = [];
    this.waiters = [];
    this.ended = undefined;
    this.cursor = 0;
    void this.read(session);
  }

  /** Reads the stream, reopening it from the last event id when the
   *  connection drops — a `kubectl port-forward` cuts long-lived streams. */
  async read(session) {
    let lastId;
    let drops = 0;
    for (;;) {
      try {
        const headers = { authorization: `Bearer ${session.secret}` };
        if (lastId !== undefined) headers["last-event-id"] = lastId;
        const res = await fetch(`${session.baseUrl}/v1/sessions/${session.id}/events`, {
          headers,
          signal: this.abort.signal,
        });
        if (!res.ok) throw new E2EFailure(`the session's event stream answered HTTP ${res.status}`);
        const decoder = new TextDecoder();
        let pending = "";
        for await (const chunk of res.body) {
          pending += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = pending.indexOf("\n\n")) !== -1) {
            const lines = pending.slice(0, end).split("\n");
            pending = pending.slice(end + 2);
            const id = lines.find((line) => line.startsWith("id: "));
            if (id) lastId = id.slice("id: ".length);
            const data = lines.find((line) => line.startsWith("data: "));
            if (data) this.push(JSON.parse(data.slice("data: ".length)));
          }
        }
        throw new E2EFailure("the session's event stream ended");
      } catch (err) {
        if (this.abort.signal.aborted) return this.finish(new E2EFailure("the event stream was closed"));
        if (err instanceof E2EFailure && err.message.includes("HTTP")) return this.finish(err);
        if (++drops > STREAM_RECONNECTS) return this.finish(err);
        console.error(`[e2e] event stream dropped (${err.message}); reconnecting from event ${lastId ?? "0"}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  push(event) {
    if (event.type === "progress") console.error(`[runner] ${event.app ? `${event.app}: ` : ""}${event.phase}: ${event.message}`);
    if (event.type === "status") console.error(`[runner] status: ${JSON.stringify(event.status)}`);
    if (event.type === "app" || event.type === "run") console.error(`[runner] ${event.type}: ${JSON.stringify(event)}`);
    this.events.push(event);
    for (const wake of this.waiters.splice(0)) wake();
  }

  finish(err) {
    this.ended = err;
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** The first event from the cursor on that `match` accepts. A `failed`
   *  status is an answer no step waits for, so it fails the step. */
  async until(description, match, timeoutMs = STEP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.events.length) {
        const event = this.events[this.cursor++];
        if (match(event)) return event;
        if (event.type === "status" && event.status.kind === "failed") {
          throw new E2EFailure(`the session failed while waiting for ${description}: ${event.status.message}`);
        }
      }
      if (this.ended) throw new E2EFailure(`waiting for ${description}: ${this.ended.message}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new E2EFailure(`${description} did not arrive within ${timeoutMs / 60_000} minutes`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close() {
    this.abort.abort();
  }
}

const isStatus = (kind) => (event) => event.type === "status" && event.status.kind === kind;

/** Polls `left` until it reports nothing. */
async function expectNothingLeft(describeLeft, left) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  let remaining = left();
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(2000);
    remaining = left();
  }
  if (remaining.length > 0) throw new E2EFailure(`${describeLeft} is left: ${remaining.join(", ")}`);
}

/**
 * The session's whole life. `substrate` names what is left of a session on the
 * runner's substrate: `workload()` its workload, `containers()` the containers
 * it started through its engine, `storage()` its storage.
 */
async function sessionLifecycle(baseUrl, image, substrate) {
  const packaged = packagedTest();
  let seed;
  try {
    seed = await seedOf(packaged);
  } finally {
    packaged.cleanup();
  }

  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace: `runner-containers-e2e-${Date.now()}`,
      apps: [{ name: APP, entryRelativePath: seed.entry }],
      config: { image, pullPolicy: "never" },
    }),
  });
  if (res.status !== 201) throw new E2EFailure(`POST /v1/sessions answered HTTP ${res.status}: ${await res.text()}`);
  const created = await res.json();
  if (!created.resumeSecret) throw new E2EFailure("an anonymous create was answered with no resume secret");
  const session = new Session(baseUrl, created.sessionId, created.resumeSecret);
  console.error(`[e2e] session ${session.id}: ${TEST}`);
  const events = new EventStream(session);
  let detach = () => {};
  try {
    await events.until("the session running", isStatus("running"));
    await events.until(`app '${APP}' ready`, (e) => e.type === "app" && e.app === APP && e.state === "ready");

    for (const set of seed.sets) await session.call("POST", "/workspace", set, 200);
    console.error(`[e2e] seeded ${seed.sets.reduce((n, s) => n + s.write.length, 0)} files`);

    detach = await session.attachOutput(APP);
    const { runId } = await session.call("POST", `/apps/${APP}/run`, { env: {}, io: "streams" }, 202);
    await events.until(`run ${runId} started`, (e) => e.type === "app" && e.app === APP && e.state === "running");
    const started = await events.until("the first generation", (e) => e.type === "run" && e.app === APP && e.phase === "started");
    if (started.trigger !== "run") throw new E2EFailure(`the first generation's trigger is '${started.trigger}', not 'run'`);
    const outcome = await events.until(
      "the generation's outcome",
      (e) => e.type === "run" && e.app === APP && (e.phase === "completed" || e.phase === "failed"),
      RUN_TIMEOUT_MS,
    );
    if (outcome.phase !== "completed" || outcome.code !== 0) {
      throw new E2EFailure(`the run ended ${JSON.stringify(outcome)}, not with exit code 0`);
    }
    await expectNothingLeft(`after the run, a container session ${session.id} started`, () => substrate.containers(session.id));

    await session.call("POST", `/apps/${APP}/stop`, {}, 202);
    await events.until(`run ${runId} ended`, (e) => e.type === "app" && e.app === APP && e.state === "ready" && e.ended?.runId === runId);
    detach();

    await session.call("POST", "/suspend", undefined, 202);
    await events.until("the session suspended", isStatus("suspended"));
    await expectNothingLeft(`after suspend, the workload of session ${session.id}`, () => substrate.workload(session.id));
    if (substrate.storage(session.id).length === 0) throw new E2EFailure(`suspend removed the storage of session ${session.id}`);

    await session.call("POST", "/resume", undefined, 202);
    await events.until("the session running again", isStatus("running"));
    const tree = await session.call("GET", "/workspace", undefined, 200);
    if (!tree.files.some((f) => f.path === seed.entry)) {
      throw new E2EFailure(`the resumed workspace has no ${seed.entry}: ${JSON.stringify(tree.files.map((f) => f.path))}`);
    }

    await session.call("DELETE", "", undefined, 204);
    await events.until("the session deleted", isStatus("stopped"));
    await session.call("GET", "", undefined, 404);
    await expectNothingLeft(`after delete, what session ${session.id} held`, () => [
      ...substrate.workload(session.id),
      ...substrate.containers(session.id),
      ...substrate.storage(session.id),
    ]);
  } finally {
    detach();
    events.close();
  }
}

/** Every container a docker runner's boot sweep may remove, running or
 *  exited, by name. */
function sweepableContainers() {
  const names = (args) => lines(read("docker", ["ps", "-a", ...args, "--format", "{{.Names}}"]));
  return [
    ...new Set([
      ...names([]).filter((name) => name.startsWith("telo-run-")),
      ...names(["--filter", "label=telo.run/session-id"]),
      ...names(["--filter", "label=run.telo.session"]),
    ]),
  ].sort();
}

function refuseOverSessionContainers() {
  const found = sweepableContainers();
  if (found.length === 0) return;
  throw new E2EFailure(
    `refusing to start a runner: this daemon holds session containers (${found.join(", ")}), and a docker ` +
      `runner removes every session container it does not run when it boots. End those sessions, or remove ` +
      `the containers, and rerun.`,
  );
}

async function dockerMode() {
  const kernelImage = options.image;
  if (kernelImage === KERNEL_IMAGE) run("docker", compose("--profile", "kernel", "build", "kernel"));
  run("docker", [
    "build", "--file", "apps/docker-runner/Dockerfile", "--target", "production", "--tag", RUNNER_IMAGE, ".",
  ]);
  refuseOverSessionContainers();
  const labelled = (label) => (id) => lines(read("docker", ["ps", "-aq", "--filter", `label=${label}=${id}`]));
  try {
    run("docker", ["network", "create", RUNNER_NETWORK]);
    run("docker", ["volume", "create", RUNNER_VOLUME]);
    run("docker", ["volume", "create", STATE_VOLUME]);
    run("docker", [
      "run", "-d", "--name", RUNNER_CONTAINER,
      "--network", RUNNER_NETWORK, "--network-alias", "runner",
      "--publish", "127.0.0.1::8061",
      "--volume", "/var/run/docker.sock:/var/run/docker.sock",
      "--volume", `${RUNNER_VOLUME}:/bundles`,
      "--volume", `${STATE_VOLUME}:/var/lib/telo-runner`,
      "--env", `BUNDLE_VOLUME=${RUNNER_VOLUME}`,
      "--env", `RUNNER_CHILD_NETWORK=${RUNNER_NETWORK}`,
      "--env", "RUNNER_STATE_DIR=/var/lib/telo-runner",
      "--env", "RUNNER_SESSION_CONTAINERS=true",
      "--env", "RUNNER_INTERNAL_URL=http://runner:8061",
      RUNNER_IMAGE,
    ]);
    const address = read("docker", ["port", RUNNER_CONTAINER, "8061/tcp"]).trim().split("\n")[0];
    const baseUrl = `http://${address}`;
    await waitForHealth(baseUrl);
    await sessionLifecycle(baseUrl, kernelImage, {
      workload: labelled("telo.run/session-id"),
      containers: labelled("run.telo.session"),
      storage: (id) =>
        lines(
          read("docker", ["exec", RUNNER_CONTAINER, "sh", "-c", `[ -d /bundles/${id} ] && echo /bundles/${id} || true`]),
        ),
    });
  } catch (err) {
    spawnSync("docker", ["logs", "--tail", "200", RUNNER_CONTAINER], { cwd: repo, env, stdio: "inherit" });
    throw err;
  } finally {
    spawnSync("docker", ["rm", "-f", RUNNER_CONTAINER], { cwd: repo, env, stdio: "ignore" });
    // Session containers outlive the runner by design, and the daemon held none
    // when this run started (refuseOverSessionContainers), so every one left is
    // this run's: its workload's and those its test started.
    for (const name of sweepableContainers()) {
      spawnSync("docker", ["rm", "-f", "-v", name], { cwd: repo, env, stdio: "ignore" });
    }
    spawnSync("docker", ["volume", "rm", RUNNER_VOLUME, STATE_VOLUME], { cwd: repo, env, stdio: "inherit" });
    spawnSync("docker", ["network", "rm", RUNNER_NETWORK], { cwd: repo, env, stdio: "inherit" });
  }
}

async function kubernetesMode() {
  const baseUrl = options["runner-url"]?.replace(/\/+$/, "");
  if (!baseUrl) throw new E2EFailure("--kubernetes needs --runner-url, where the chart's runner answers");
  const namespace = options.namespace;
  const kubectl = (...args) => lines(read("kubectl", ["-n", namespace, ...args]));
  await waitForHealth(baseUrl);
  await sessionLifecycle(baseUrl, options.image, {
    workload: (id) => kubectl("get", "pods", "-l", `telo.run/session-id=${id}`, "-o", "name"),
    containers: (id) => kubectl("get", "pods", "-l", `run.telo.session=${id}`, "-o", "name"),
    // The policies opening the path to a session's containers are the session's,
    // not a run's: they go when the session does.
    storage: (id) => [
      ...kubectl("get", "pvc", "-l", `telo.run/session-id=${id}`, "-o", "name"),
      ...kubectl("get", "networkpolicies", "-o", "name").filter((name) => name.includes(`telo-ctr-${id}-`)),
    ],
  });
}

try {
  if (options.kubernetes) await kubernetesMode();
  else await dockerMode();
  console.error("[e2e] the session ran its test to exit code 0, suspended, resumed and was deleted, leaving nothing behind");
} catch (err) {
  console.error(err instanceof E2EFailure ? `[e2e] ${err.message}` : err);
  process.exitCode = 1;
}
