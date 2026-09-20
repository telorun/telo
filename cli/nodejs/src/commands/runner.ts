import * as os from "node:os";
import * as path from "node:path";

import type { RunnerCoreConfig } from "@telorun/runner-core";
import type { Argv } from "yargs";

import { cliVersion } from "../distribution-versions.js";
import { outEmit, outErrLine, outLine } from "../output.js";

interface RunnerArgv {
  port: number;
  /** The global `--verbose`, which here turns the per-request log on. */
  verbose: boolean;
  host: string;
  allowRemote: boolean;
  allowOrigin: string[];
  stateDir?: string;
  watchSessions: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The port every Telo runner listens on unless told otherwise. */
const DEFAULT_PORT = 8061;

/** How long a shutdown waits for in-flight HTTP requests to finish before it
 *  stops waiting. Every session is already down by then; what remains is a
 *  client holding a stream open. */
const DRAIN_TIMEOUT_MS = 3_000;

export function runnerCommand(cli: Argv): Argv {
  return cli.command(
    "runner",
    "Serve the /v1 runner API over local processes, so an editor (or any client) can run applications on this machine",
    (yargs) =>
      yargs
        .option("port", {
          type: "number",
          default: DEFAULT_PORT,
          describe: "Port to listen on. `0` picks a free one and reports it.",
        })
        .option("host", {
          type: "string",
          default: "127.0.0.1",
          describe:
            "Address to bind. Anything but loopback needs --allow-remote: this API runs applications with the invoking user's privileges and has no authentication.",
        })
        .option("allow-remote", {
          type: "boolean",
          default: false,
          describe:
            "Permit a non-loopback bind. Everyone who can reach the port can run code as this user.",
        })
        .option("allow-origin", {
          type: "array",
          string: true,
          default: [] as string[],
          describe:
            "A browser origin allowed to drive this runner (repeatable). None by default: a page on any site can reach 127.0.0.1, and this API runs code. Native clients, which send no Origin, are unaffected.",
        })
        .option("state-dir", {
          type: "string",
          describe:
            "Where session workspaces are staged (default: a `telo-runner` directory under the system temp directory).",
        })
        .option("watch-sessions", {
          type: "boolean",
          default: true,
          describe:
            "Offer watch sessions — a workspace that runs continuously, where an edit costs a kernel reload. Use --no-watch-sessions to serve one-shot runs only.",
        }),
    async (argv) => {
      await runRunner(argv as unknown as RunnerArgv);
    },
  );
}

async function runRunner(argv: RunnerArgv): Promise<void> {
  // A non-loopback bind is refused rather than warned about: this API starts
  // processes as the invoking user and authenticates nobody, so exposing it is
  // a decision, not a default.
  if (!LOOPBACK.has(argv.host) && !argv.allowRemote) {
    outErrLine(
      `telo runner: refusing to bind ${argv.host}. This API runs applications as ${os.userInfo().username} ` +
        `with no authentication, so a non-loopback bind must be asked for explicitly: pass --allow-remote.`,
    );
    process.exitCode = 2;
    return;
  }

  if (!Number.isInteger(argv.port) || argv.port < 0 || argv.port > 65535) {
    outErrLine(`telo runner: --port must be 0 (pick a free one) or 1..65535, got '${argv.port}'.`);
    process.exitCode = 2;
    return;
  }

  // Loaded here rather than at module scope: this is the only command that
  // needs a web server, and a static import puts fastify, pino and ws on the
  // startup path of every `telo check` and `telo run` (~70ms of a ~270ms
  // start). The command surface is unchanged — yargs registration above stays
  // static, so `--help` still lists it.
  const { buildServer, loadCoreConfig, parseCorsOrigins, stopAllSessions } = await import(
    "@telorun/runner-core"
  );
  const { createProcessBackend } = await import("../runner/process-backend.js");
  const { prepareStateRoot, releaseStateRoot } = await import("../runner/state-root.js");
  const { localRunnerCapabilities, validateLocalRunnerConfig } = await import(
    "../runner/capabilities.js"
  );

  const stateRoot = argv.stateDir
    ? path.resolve(argv.stateDir)
    : path.join(os.tmpdir(), "telo-runner");

  // Private to this user, and owned by this process: a session workspace holds
  // the user's source, and a runner that is killed leaves one behind with
  // nothing that knows about it. The sweep is what reclaims those.
  let ownRoot: string;
  try {
    const prepared = await prepareStateRoot(stateRoot);
    ownRoot = prepared.ownRoot;
    if (prepared.swept.length > 0) {
      outErrLine(
        `telo runner: reclaimed ${prepared.swept.length} session directory/-ies left by runners that are no longer running.`,
      );
    }
  } catch (err) {
    outErrLine(`telo runner: could not prepare '${stateRoot}': ${message(err)}`);
    process.exitCode = 1;
    return;
  }

  const backend = createProcessBackend({ stateRoot: ownRoot });
  const capabilities = localRunnerCapabilities({ watch: argv.watchSessions });

  // The env-driven core config stays the way every runner reads it (ceilings,
  // buffers, CORS), with the two answers this command owns written over it: the
  // port it was told to listen on, and whether watch sessions are offered.
  // `port: 0` is this command's "pick a free one", which the env parser refuses
  // as a PORT value — so the fallback it is handed is a real port and the
  // requested one is written over it below.
  let base: RunnerCoreConfig;
  try {
    base = loadCoreConfig(process.env, { port: argv.port > 0 ? argv.port : DEFAULT_PORT });
  } catch (err) {
    outErrLine(`telo runner: ${message(err)}`);
    process.exitCode = 2;
    return;
  }
  const config: RunnerCoreConfig = {
    ...base,
    port: argv.port,
    // **No browser origin by default.** `*` is right for a runner an operator
    // deployed behind their own network; it is wrong here, because every page
    // the user visits can reach 127.0.0.1 from their browser, and a
    // cross-origin `POST /v1/sessions` that a `*` preflight waves through runs
    // arbitrary code as this user. The port being random (as the editor starts
    // it) is not the gate — the default 8061 is documented. An operator who
    // sets RUNNER_CORS_ORIGINS still gets what they asked for.
    corsOrigins: corsOriginsFor(argv, parseCorsOrigins),
    // A per-request log belongs to an operator watching a shared runner, not to
    // someone running one desktop session, so this one is quiet until asked.
    logLevel: process.env.LOG_LEVEL?.trim() || (argv.verbose ? "info" : "warn"),
    watch: { ...base.watch, enabled: argv.watchSessions },
  };

  const { app, registry } = await buildServer({
    backend,
    config,
    version: cliVersion() ?? "unversioned build",
    capabilities,
    validateConfig: validateLocalRunnerConfig,
    // The runner's own log is diagnostics, so it goes where every other
    // CLI-owned diagnostic goes: stderr. On stdout it would sit in the middle
    // of the `-o json` payload.
    logStream: process.stderr,
  });

  try {
    await app.listen({ port: argv.port, host: argv.host });
  } catch (err) {
    outErrLine(`telo runner: could not listen on ${argv.host}:${argv.port}: ${message(err)}`);
    process.exitCode = 1;
    return;
  }

  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : argv.port;
  const url = `http://${argv.host === "::1" ? "[::1]" : argv.host}:${port}`;

  outLine(`telo runner listening on ${url}`);
  outLine(`Applications run as ${os.userInfo().username}, from ${ownRoot}.`);
  // The result of this command is the address it is serving, which is what a
  // supervising client needs before it can dial. Written once, as soon as it is
  // true, because the command does not end until the runner is stopped.
  outEmit({ url, host: argv.host, port, watch: argv.watchSessions, stateDir: ownRoot });

  /**
   * Stop everything this runner started, then go.
   *
   * **Workloads first, and the HTTP close bounded.** A runner's own streams are
   * requests that never end — an SSE event stream, an attached byte channel —
   * so `close()` waits on them for as long as a client stays connected. Waiting
   * there first is what leaves `telo run --watch` processes alive until the
   * supervisor's patience runs out and SIGKILLs this process, which orphans
   * them holding the user's ports. So the workloads are killed while this
   * process is still the one that knows about them, and the server drain gets a
   * deadline rather than a promise.
   */
  const shutdown = async (signal: string): Promise<void> => {
    for (const entry of registry.list()) entry.userStopped = true;
    await stopAllSessions(registry, app.log);
    await Promise.race([app.close(), delay(DRAIN_TIMEOUT_MS)]);
    await releaseStateRoot(stateRoot);
    outErrLine(`telo runner: stopped (${signal}).`);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/** `RUNNER_CORS_ORIGINS` when an operator set one (including `*`), otherwise the
 *  origins this invocation named — none, unless asked. */
function corsOriginsFor(
  argv: RunnerArgv,
  parseCorsOrigins: (raw: string | undefined) => string[] | "*",
): string[] | "*" {
  const fromEnv = process.env.RUNNER_CORS_ORIGINS?.trim();
  if (fromEnv) return parseCorsOrigins(fromEnv);
  return argv.allowOrigin.map((origin) => origin.trim()).filter((origin) => origin.length > 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
