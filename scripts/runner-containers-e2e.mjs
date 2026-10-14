#!/usr/bin/env node
// `node scripts/runner-containers-e2e.mjs` — a container-backed integration test,
// unchanged, run as a RUN session over a runner's `/v1`, with the runner serving
// the session its container engine. The session must exit 0 and leave no
// container behind.
//
//   node scripts/runner-containers-e2e.mjs
//       Docker: runs the docker runner's `production` image, built from this
//       tree as `telorun/docker-runner:e2e` — never the development stack's
//       runner or its image tag — configured with only the settings the feature
//       needs, on a loopback port the daemon assigns. It mounts no checkout and
//       writes nothing into it, so a development stack watching the checkout is
//       never restarted by it. It owns, and always removes, its runner, network
//       and bundles volume, all named `telo-runner-e2e…`. The session runs on
//       the kernel image built from this tree (the `kernel` compose service,
//       `telo-dev/node:local`), which this command builds. A docker runner
//       removes every session container on its daemon when it boots — any
//       container named `telo-run-*` or labelled `run.telo.session`, whichever
//       runner started it — so this command refuses to run, exiting 1 and
//       naming them, while any such container exists; it removes none itself.
//       The check is taken immediately before its runner starts, so a session
//       started elsewhere during that runner's boot is still taken.
//
//   node scripts/runner-containers-e2e.mjs --kubernetes --runner-url <url> \
//       [--namespace telo-sessions] [--image telo-dev/node:local]
//       Kubernetes: drives a runner already installed from the chart with
//       `session.containers.enabled=true` (the kind job in `e2e.yml`), and checks
//       the session namespace for the session's pods and policies afterwards.
//
// The test imports its modules by relative path, and a session has no
// `node_modules` to build a module's controller against, so the bundle is what
// `telo package` carries: every local module with its controllers built, the
// TypeScript sources left behind. Built bundles are minified (whitespace and
// syntax only) because `POST /v1/sessions` takes a body of at most 1 MiB.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { transform } from "esbuild";

const repo = path.resolve(import.meta.dirname, "..");
const TEST = "modules/vector-store-pgvector/tests/integration/filtered-top-k.yaml";
const PROJECT = "telo-runner-e2e";
const RUNNER_CONTAINER = `${PROJECT}-runner`;
const RUNNER_NETWORK = `${PROJECT}-network`;
const RUNNER_VOLUME = `${PROJECT}-bundles`;
const RUNNER_IMAGE = "telorun/docker-runner:e2e";
const KERNEL_IMAGE = "telo-dev/node:local";
const SESSION_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 90_000;

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

async function bundleOf(app) {
  const files = [];
  for (const found of readdirSync(app.dir, { recursive: true, withFileTypes: true })) {
    if (!found.isFile()) continue;
    const file = path.join(found.parentPath, found.name);
    let contents = readFileSync(file, "utf8");
    if (file.endsWith(".mjs")) {
      contents = (await transform(contents, { loader: "js", format: "esm", minifyWhitespace: true, minifySyntax: true })).code;
    }
    files.push({ relativePath: path.relative(app.dir, file).split(path.sep).join("/"), contents });
  }
  return { entryRelativePath: app.entry, files };
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

/** The session's output, printed as it arrives so a failure shows its cause. */
function attachOutput(baseUrl, sessionId) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/v1/sessions/${sessionId}/io`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (message) => {
    if (typeof message.data === "string") return;
    process.stderr.write(Buffer.from(message.data).subarray(5));
  });
  return () => socket.close();
}

/** Every event of the session until its terminal status, which is returned. */
async function terminalStatus(baseUrl, sessionId) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SESSION_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/events`, { signal: abort.signal });
    if (!res.ok) throw new E2EFailure(`the session's event stream answered HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice("data: ".length));
        if (event.type === "progress") console.error(`[runner] ${event.phase}: ${event.message}`);
        if (event.type !== "status") continue;
        console.error(`[runner] status: ${JSON.stringify(event.status)}`);
        if (["exited", "failed", "stopped"].includes(event.status.kind)) return event.status;
      }
    }
    throw new E2EFailure("the session's event stream ended before a terminal status");
  } catch (err) {
    if (abort.signal.aborted) throw new E2EFailure(`the session did not end within ${SESSION_TIMEOUT_MS / 60_000} minutes`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function runSession(baseUrl, image) {
  const app = packagedTest();
  let bundle;
  try {
    bundle = await bundleOf(app);
  } finally {
    app.cleanup();
  }
  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle, env: {}, config: { image, pullPolicy: "never" } }),
  });
  if (res.status !== 201) {
    throw new E2EFailure(`POST /v1/sessions answered HTTP ${res.status}: ${await res.text()}`);
  }
  const { sessionId } = await res.json();
  console.error(`[e2e] session ${sessionId}: ${TEST}`);
  const detach = attachOutput(baseUrl, sessionId);
  try {
    const status = await terminalStatus(baseUrl, sessionId);
    if (status.kind !== "exited" || status.code !== 0) {
      throw new E2EFailure(`the session ended ${JSON.stringify(status)}, not with exit code 0`);
    }
  } finally {
    detach();
  }
  return sessionId;
}

/** Polls `left` until it reports nothing; the runner removes a session's
 *  containers once its terminal status is out. */
async function expectNothingLeft(describeLeft, left) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  let remaining = left();
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(2000);
    remaining = left();
  }
  if (remaining.length > 0) {
    throw new E2EFailure(`${describeLeft} is left after the session ended: ${remaining.join(", ")}`);
  }
}

/** Every container a docker runner's boot sweep would remove, running or
 *  exited, by name. */
function sessionContainers() {
  const names = (args) => read("docker", ["ps", "-a", ...args, "--format", "{{.Names}}"]).split("\n").filter(Boolean);
  const named = names([]).filter((name) => name.startsWith("telo-run-"));
  return [...new Set([...named, ...names(["--filter", "label=run.telo.session"])])].sort();
}

function refuseOverSessionContainers() {
  const found = sessionContainers();
  if (found.length === 0) return;
  throw new E2EFailure(
    `refusing to start a runner: this daemon holds session containers (${found.join(", ")}), and a docker ` +
      `runner removes every session container on its daemon when it boots. End those sessions, or remove ` +
      `the containers, and rerun.`,
  );
}

async function dockerMode() {
  run("docker", compose("--profile", "kernel", "build", "kernel"));
  run("docker", [
    "build", "--file", "apps/docker-runner/Dockerfile", "--target", "production", "--tag", RUNNER_IMAGE, ".",
  ]);
  refuseOverSessionContainers();
  try {
    run("docker", ["network", "create", RUNNER_NETWORK]);
    run("docker", ["volume", "create", RUNNER_VOLUME]);
    run("docker", [
      "run", "-d", "--name", RUNNER_CONTAINER,
      "--network", RUNNER_NETWORK, "--network-alias", "runner",
      "--publish", "127.0.0.1::8061",
      "--volume", "/var/run/docker.sock:/var/run/docker.sock",
      "--volume", `${RUNNER_VOLUME}:/bundles`,
      "--env", `BUNDLE_VOLUME=${RUNNER_VOLUME}`,
      "--env", `RUNNER_CHILD_NETWORK=${RUNNER_NETWORK}`,
      "--env", "RUNNER_SESSION_CONTAINERS=true",
      "--env", "RUNNER_INTERNAL_URL=http://runner:8061",
      RUNNER_IMAGE,
    ]);
    const address = read("docker", ["port", RUNNER_CONTAINER, "8061/tcp"]).trim().split("\n")[0];
    const baseUrl = `http://${address}`;
    await waitForHealth(baseUrl);
    const sessionId = await runSession(baseUrl, KERNEL_IMAGE);
    await expectNothingLeft(`a container of session ${sessionId}`, () =>
      read("docker", ["ps", "-aq", "--filter", `label=run.telo.session=${sessionId}`]).split("\n").filter(Boolean),
    );
  } catch (err) {
    spawnSync("docker", ["logs", "--tail", "200", RUNNER_CONTAINER], { cwd: repo, env, stdio: "inherit" });
    throw err;
  } finally {
    spawnSync("docker", ["rm", "-f", RUNNER_CONTAINER], { cwd: repo, env, stdio: "ignore" });
    spawnSync("docker", ["volume", "rm", RUNNER_VOLUME], { cwd: repo, env, stdio: "inherit" });
    spawnSync("docker", ["network", "rm", RUNNER_NETWORK], { cwd: repo, env, stdio: "inherit" });
  }
}

async function kubernetesMode() {
  const baseUrl = options["runner-url"]?.replace(/\/+$/, "");
  if (!baseUrl) throw new E2EFailure("--kubernetes needs --runner-url, where the chart's runner answers");
  const namespace = options.namespace;
  await waitForHealth(baseUrl);
  const sessionId = await runSession(baseUrl, options.image);
  await expectNothingLeft(`a pod or network policy of session ${sessionId}`, () => [
    ...read("kubectl", ["get", "pods", "-n", namespace, "-l", `run.telo.session=${sessionId}`, "-o", "name"])
      .split("\n")
      .filter(Boolean),
    ...read("kubectl", ["get", "networkpolicies", "-n", namespace, "-o", "name"])
      .split("\n")
      .filter((name) => name.includes(`telo-ctr-${sessionId}-`)),
  ]);
}

try {
  if (options.kubernetes) await kubernetesMode();
  else await dockerMode();
  console.error("[e2e] the session exited 0 and left nothing behind");
} catch (err) {
  console.error(err instanceof E2EFailure ? `[e2e] ${err.message}` : err);
  process.exitCode = 1;
}
