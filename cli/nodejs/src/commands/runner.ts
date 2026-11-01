import * as os from "node:os";

import type { RunnerAgent, RunnerCoreConfig } from "@telorun/runner-core";
import type { Argv } from "yargs";

import { cliVersion } from "../distribution-versions.js";
import { EXIT_REFUSED } from "../exit-status.js";
import { outEmit, outErrLine, outLine } from "../output.js";
import { containerRunnerSettingRefusal } from "../runner/container-runner-settings.js";

interface RunnerArgv {
  port: number;
  /** The global `--verbose`, which here turns the per-request log on. */
  verbose: boolean;
  host: string;
  allowRemote: boolean;
  allowOrigin: string[];
  stateDir?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The port every Telo runner listens on unless told otherwise. */
const DEFAULT_PORT = 8061;

/** How long a shutdown waits for in-flight HTTP requests to finish before it
 *  stops waiting. Every run has ended by then; what remains is a client holding
 *  a stream open. */
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
            "The runner's state directory: the session store and every session's directory, kept across suspends, restarts and reboots. Overrides RUNNER_STATE_DIR; default the per-user state directory (Linux $XDG_STATE_HOME/telo/runner or ~/.local/state/telo/runner, macOS ~/Library/Application Support/telo/runner, Windows %LOCALAPPDATA%\\telo\\state\\runner).",
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
    process.exitCode = EXIT_REFUSED;
    return;
  }

  if (!Number.isInteger(argv.port) || argv.port < 0 || argv.port > 65535) {
    outErrLine(`telo runner: --port must be 0 (pick a free one) or 1..65535, got '${argv.port}'.`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const refusal = containerRunnerSettingRefusal(process.env, os.userInfo().username);
  if (refusal) {
    outErrLine(`telo runner: ${refusal}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  // Loaded here rather than at module scope: this is the only command that
  // needs a web server, and a static import puts fastify, pino and ws on the
  // startup path of every `telo check` and `telo run` (~70ms of a ~270ms
  // start). The command surface is unchanged — yargs registration above stays
  // static, so `--help` still lists it.
  const { buildServer, loadCoreConfig, openSessionStore, parseCorsOrigins } = await import(
    "@telorun/runner-core"
  );
  const { createProcessBackend } = await import("../runner/process-backend.js");
  const { prepareStateRoot, resolveStateRoot, STATE_DIR_ENV } = await import(
    "../runner/state-root.js"
  );
  const { localRunnerCapabilities, validateLocalRunnerConfig } = await import(
    "../runner/capabilities.js"
  );
  const { loadLocalAgent } = await import("../runner/local-agent.js");

  // The co-resident agent, from the operator's `AGENT_*` variables.
  let agent: RunnerAgent | undefined;
  try {
    agent = loadLocalAgent(process.env);
  } catch (err) {
    outErrLine(`telo runner: ${message(err)}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const resolution = resolveStateRoot(argv.stateDir, process.env, process.platform, process.cwd());
  if ("refusal" in resolution) {
    outErrLine(`telo runner: ${resolution.refusal}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  const stateRoot = resolution.root;

  // Private to this user: a session directory holds the user's source.
  try {
    await prepareStateRoot(stateRoot);
  } catch (err) {
    const source = resolution.from === "default" ? "the per-user default" : resolution.from;
    outErrLine(
      `telo runner: cannot keep state in '${stateRoot}' (${source}): ${message(err)}. ` +
        `Name a writable directory with --state-dir <dir> or ${STATE_DIR_ENV}.`,
    );
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const { createTeloSupply } = await import("../runner/telo-supply.js");
  const { hostReleaseTarget } = await import("../release-binary.js");
  const { carriersRoot } = await import("../package/app-home.js");
  const { TELO_RUNTIME_VERSION } = await import("@telorun/kernel");
  const backend = createProcessBackend({
    stateRoot,
    telo: createTeloSupply({
      identity: TELO_RUNTIME_VERSION,
      hostTarget: hostReleaseTarget(),
      cacheRoot: carriersRoot(),
    }),
    onSwept: (names) =>
      outErrLine(
        `telo runner: removed ${names.length} session director${names.length === 1 ? "y" : "ies"} no stored session owns.`,
      ),
  });

  // The env-driven core config stays the way every runner reads it (ceilings,
  // buffers, CORS, the session store), with what this command owns written
  // over it: the port it was told to listen on, and the state root, already
  // resolved with `RUNNER_STATE_DIR` in its place, where the SQLite store lives.
  // `port: 0` is this command's "pick a free one", which the env parser refuses
  // as a PORT value — so the fallback it is handed is a real port and the
  // requested one is written over it below.
  let base: RunnerCoreConfig;
  try {
    base = loadCoreConfig(process.env, {
      port: argv.port > 0 ? argv.port : DEFAULT_PORT,
      stateDir: stateRoot,
    });
  } catch (err) {
    outErrLine(`telo runner: ${message(err)}`);
    process.exitCode = EXIT_REFUSED;
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
  };

  const store = await openSessionStore(config.sessionStore, {
    log: {
      error: (detail, msg) =>
        outErrLine(`telo runner: ${msg}: ${message((detail as { err?: unknown }).err ?? detail)}`),
    },
  }).catch((err: unknown) => {
    outErrLine(`telo runner: could not open the session store: ${message(err)}`);
    return undefined;
  });
  if (!store) {
    process.exitCode = 1;
    return;
  }

  let server: Awaited<ReturnType<typeof buildServer>>;
  try {
    // Boot happens here: every stored session is loaded and, since nothing a
    // local runner started outlives it, marked suspended; then the sweep runs.
    server = await buildServer({
      backend,
      config,
      store,
      version: cliVersion() ?? "unversioned build",
      capabilities: localRunnerCapabilities(agent),
      agent,
      validateConfig: validateLocalRunnerConfig,
      // The runner's own log is diagnostics, so it goes where every other
      // CLI-owned diagnostic goes: stderr. On stdout it would sit in the middle
      // of the `-o json` payload.
      logStream: process.stderr,
    });
  } catch (err) {
    await store.close();
    outErrLine(`telo runner: ${message(err)}`);
    process.exitCode = 1;
    return;
  }
  const { app, lifecycle } = server;

  try {
    await app.listen({ port: argv.port, host: argv.host });
  } catch (err) {
    outErrLine(`telo runner: could not listen on ${argv.host}:${argv.port}: ${message(err)}`);
    await app.close();
    await store.close();
    process.exitCode = 1;
    return;
  }

  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : argv.port;
  const url = `http://${argv.host === "::1" ? "[::1]" : argv.host}:${port}`;

  outLine(`telo runner listening on ${url}`);
  outLine(`Applications run as ${os.userInfo().username}, from ${stateRoot}.`);
  // The result of this command is the address it is serving, which is what a
  // supervising client needs before it can dial. Written once, as soon as it is
  // true, because the command does not end until the runner is stopped.
  outEmit({ url, host: argv.host, port, stateDir: stateRoot });

  /**
   * End every run this runner started, then go.
   *
   * **Runs first, and the HTTP close bounded.** A runner's own streams are
   * requests that never end — an SSE event stream, an attached byte channel —
   * so `close()` waits on them for as long as a client stays connected. Waiting
   * there first is what leaves `telo run --watch` processes alive until the
   * supervisor's patience runs out and SIGKILLs this process, which orphans
   * them holding the user's ports. So the lifecycle detaches every workload
   * (ending its runs, keeping its directory) while this process is still the
   * one that knows about them, and the server drain gets a deadline.
   */
  const shutdown = async (signal: string): Promise<void> => {
    await lifecycle.close();
    await Promise.race([app.close(), delay(DRAIN_TIMEOUT_MS)]);
    await store.close();
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
