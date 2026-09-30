#!/usr/bin/env node
// `pnpm run test:e2e:hub` — the one entry point for the hub's end-to-end suites,
// for developers and CI alike. It stands up a fresh stack under a compose
// project of its own (never attaching to a running one), waits for the hub's
// first tracking pass, runs the hub's suite and then hub-web's, and always
// tears the stack down. On failure the suites' output and the stack's logs are
// written to `e2e-logs/`.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repo = path.resolve(import.meta.dirname, "..");
const logDir = path.join(repo, "e2e-logs");
const project = "telo-hub-e2e";
const composeFiles = ["-f", "docker-compose.yml", "-f", "docker-compose.hub-e2e.yml"];
const services = ["db", "storage", "embedder", "hub", "hub-web"];
// The suites address these literally.
const ports = { hub: 8040, hubWeb: 8050 };
const suites = [
  { manifest: "apps/hub/test-suite-e2e.yaml", log: "hub-suite.log" },
  { manifest: "apps/hub-web/test-suite-e2e.yaml", log: "hub-web-suite.log" },
];

const env = {
  ...process.env,
  HUB_PORT: String(ports.hub),
  HUB_WEB_PORT: String(ports.hubWeb),
  HUB_WEB_TARGET: "production",
  // Its own image tag, so this run never replaces the development stack's images.
  DOCKER_TAG: "e2e",
  // Absolute: Bun's spawn stops at a relative `./node_modules/.bin` with ENOENT
  // for a child whose working directory differs, and a test spawns `bun`.
  PATH: `${path.join(repo, "node_modules", ".bin")}${path.delimiter}${process.env.PATH}`,
};

class E2EFailure extends Error {}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

function describe(command, args) {
  return [command, ...args].join(" ");
}

/** Runs to completion with the output shown; throws on a non-zero exit. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new E2EFailure(`\`${describe(command, args)}\` exited with ${result.status ?? result.signal}`);
  }
}

/** Runs to completion and returns stdout; throws with stderr on a non-zero exit. */
function read(command, args) {
  const result = spawnSync(command, args, { cwd: repo, env, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new E2EFailure(
      `\`${describe(command, args)}\` exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

const compose = (...args) => ["compose", "-p", project, ...composeFiles, ...args];

async function refuseTakenPorts() {
  for (const port of Object.values(ports)) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") {
          reject(
            new E2EFailure(
              `port ${port} is already in use — a running development stack, most likely. ` +
                `This command stands up a fresh stack of its own on ports ${ports.hub} and ${ports.hubWeb} ` +
                `and never attaches to an existing one; free port ${port} and run it again.`,
            ),
          );
        } else {
          reject(error);
        }
      });
      server.listen(port, () => server.close(resolve));
    });
  }
}

function psql(sql) {
  return read("docker", compose("exec", "-T", "db", "psql", "-U", "postgres", "-d", "hub", "-tAc", sql)).trim();
}

function psqlTable(sql) {
  return read("docker", compose("exec", "-T", "db", "psql", "-U", "postgres", "-d", "hub", "-c", sql));
}

/** The loopback address Docker assigned the db's 5432 — the hub suite's
 *  integration tests connect to it from the host. */
function dbAddress() {
  const args = compose("port", "db", "5432");
  const answer = read("docker", args).trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(answer);
  if (!match) {
    throw new E2EFailure(
      `\`${describe("docker", args)}\` did not answer a loopback address; its output was: ${JSON.stringify(answer)}`,
    );
  }
  return { host: "127.0.0.1", port: match[1] };
}

/**
 * The hub is healthy well before its first tracking pass finishes, and the pass
 * walks SEED_REFS in order, so the suites wait on what their assertions READ,
 * read the way the hub reads it. Every search path joins
 * `rk.version = m.latest_version`, so a module is queryable only once its
 * LATEST version's kinds are in (or, for a module that defines no kind, its
 * exported resources). Counting kinds at any version, or waiting on
 * `last_tracked_at` (stamped when a ref's pass ends, success or failure, by a
 * different step than the one writing kinds), both passed over a partial index.
 * Plus at least one embedding, for the semantic assertion. A recorded
 * `last_error` is a hard failure, not a ref that finished. The expected count
 * comes from the hub's own environment, so editing SEED_REFS never leaves this
 * gate behind.
 */
async function waitForSeedPass() {
  const expected = JSON.parse(read("docker", compose("exec", "-T", "hub", "printenv", "SEED_REFS"))).length;
  if (!(expected > 0)) throw new E2EFailure("SEED_REFS in the hub container lists no refs");
  console.log(`seeded refs: ${expected}`);

  for (let attempt = 0; attempt < 60; attempt++) {
    if (interrupted) throw new E2EFailure("interrupted");
    const failed = Number(psql("SELECT count(*) FROM modules WHERE last_error IS NOT NULL"));
    if (failed > 0) {
      console.error(psqlTable("SELECT ref, last_error FROM modules WHERE last_error IS NOT NULL ORDER BY ref"));
      throw new E2EFailure(`${failed} seeded ref(s) failed to ingest`);
    }
    const total = Number(psql("SELECT count(*) FROM modules"));
    const indexed = Number(
      psql(
        "SELECT count(*) FROM modules m WHERE coalesce(m.latest_version, '') <> '' AND (" +
          "EXISTS (SELECT 1 FROM resource_kinds rk WHERE rk.module_id = m.id AND rk.version = m.latest_version) OR " +
          "EXISTS (SELECT 1 FROM module_resources mr WHERE mr.module_id = m.id AND mr.version = m.latest_version))",
      ),
    );
    const kinds = Number(
      psql(
        "SELECT count(*) FROM resource_kinds rk JOIN modules m ON m.id = rk.module_id AND m.latest_version = rk.version",
      ),
    );
    const vectors = Number(psql("SELECT count(*) FROM resource_vectors"));
    console.log(
      `modules: ${indexed}/${total} queryable of ${expected} seeded; kinds at latest: ${kinds}; resource_vectors: ${vectors}`,
    );
    if (total >= expected && indexed >= expected && vectors > 0) return;
    await sleep(5000);
  }

  console.error(
    psqlTable(
      `SELECT m.ref, m.latest_version, m.last_tracked_at, m.last_error,
              count(rk.*) FILTER (WHERE rk.version = m.latest_version) AS kinds_at_latest,
              count(rk.*) AS kinds_any_version
         FROM modules m LEFT JOIN resource_kinds rk ON rk.module_id = m.id
        GROUP BY m.id, m.ref, m.latest_version, m.last_tracked_at, m.last_error
        ORDER BY m.ref`,
    ),
  );
  throw new E2EFailure("the hub never indexed a LATEST-version kind or exported resource for every seeded ref");
}

/** hub-web must serve the whole run from one process: nothing it answers may
 *  depend on a restart. `running` catches an exit with no restart policy. */
function hubWebProcess() {
  const id = read("docker", compose("ps", "-q", "hub-web")).trim();
  if (!id) throw new E2EFailure("no hub-web container in the stack");
  const [container] = JSON.parse(read("docker", ["inspect", id]));
  return {
    startedAt: container.State.StartedAt,
    restartCount: container.RestartCount,
    running: container.State.Running,
  };
}

/** Streams the suite's output live and keeps it for the failure logs. */
function runSuite(manifest) {
  return new Promise((resolve, reject) => {
    const output = [];
    const child = spawn("bun", ["./cli/nodejs/bin/telo.ts", "--debug", manifest], {
      cwd: repo,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ passed: code === 0, exit: code ?? signal, output: Buffer.concat(output) }),
    );
  });
}

function writeLog(name, content) {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, name), content);
}

function dumpStackLogs() {
  const ps = spawnSync("docker", compose("ps", "-a"), { cwd: repo, env, encoding: "utf8" });
  const logs = spawnSync("docker", compose("logs", "--no-color", "--timestamps"), {
    cwd: repo,
    env,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const failures = [ps, logs].filter((r) => r.error || r.status !== 0);
  writeLog(
    "hub-stack.log",
    [ps.stdout, ps.stderr, logs.stdout, logs.stderr].filter(Boolean).join("\n"),
  );
  console.error(`stack logs: ${path.join(logDir, "hub-stack.log")}`);
  for (const failure of failures) {
    console.error(`collecting stack logs failed: ${failure.error ?? failure.stderr}`);
  }
  return failures.length === 0;
}

async function main() {
  await refuseTakenPorts();

  const failures = [];
  let stackStarted = false;
  try {
    run("docker", compose("down", "-v", "--remove-orphans"));
    stackStarted = true;
    // The hub's development stage writes here as a non-root user; created by the
    // caller so the directory is not root-owned.
    mkdirSync(path.join(repo, "apps/hub/.telo"), { recursive: true });
    // Generous: on first boot the embedder pulls its image and downloads the
    // model weights before it is healthy.
    run("docker", compose("up", "-d", "--build", "--wait", "--wait-timeout", "420", ...services));
    const db = dbAddress();
    // Overrides whatever the caller's shell holds: the suites must only ever
    // reach this stack's database.
    Object.assign(env, {
      DB_HOST: db.host,
      DB_PORT: db.port,
      DB_USER: "postgres",
      DB_PASSWORD: "postgres",
      DB_NAME: "postgres",
    });
    console.log(`db: ${db.host}:${db.port}`);
    await waitForSeedPass();

    const before = hubWebProcess();
    for (const suite of suites) {
      if (interrupted) throw new E2EFailure("interrupted");
      console.log(`\n=== ${suite.manifest}`);
      const result = await runSuite(suite.manifest);
      if (!result.passed) {
        failures.push(`${suite.manifest} failed (exit ${result.exit})`);
        writeLog(suite.log, result.output);
        console.error(`suite output: ${path.join(logDir, suite.log)}`);
      }
    }
    const after = hubWebProcess();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      failures.push(
        `hub-web did not serve the whole run from one process: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
      );
    }
  } catch (error) {
    failures.push(error instanceof E2EFailure ? error.message : (error?.stack ?? String(error)));
  }

  if (failures.length > 0 && stackStarted && !dumpStackLogs()) {
    failures.push("the stack's logs could not be collected in full");
  }

  if (stackStarted) {
    try {
      run("docker", compose("down", "-v", "--remove-orphans"));
    } catch (error) {
      failures.push(`tearing the stack down failed: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    console.error("\nhub e2e FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nhub e2e passed");
}

main().catch((error) => {
  console.error(error instanceof E2EFailure ? `hub e2e: ${error.message}` : error);
  process.exit(1);
});
