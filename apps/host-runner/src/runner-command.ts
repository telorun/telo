import * as os from "node:os";

import { carriersRoot, hostReleaseTarget } from "@telorun/cli/release-binary";
import { TELO_RUNTIME_VERSION } from "@telorun/kernel";
import {
  buildServer,
  loadCoreConfig,
  loadRootSecretSeed,
  openSessionStore,
  parseCorsOrigins,
  type RunnerAgent,
  type RunnerCoreConfig,
} from "@telorun/runner-core";
import yargs from "yargs";

import { localRunnerCapabilities, validateLocalRunnerConfig } from "./runner/capabilities.js";
import { containerRunnerSettingRefusal } from "./runner/container-runner-settings.js";
import { loadLocalAgent } from "./runner/local-agent.js";
import { createProcessBackend } from "./runner/process-backend.js";
import { prepareStateRoot, resolveStateRoot, STATE_DIR_ENV } from "./runner/state-root.js";
import { createTeloSupply } from "./runner/telo-supply.js";
import { configureOutput, OUTPUT_FORMATS, outEmit, outErrLine, outLine, type OutputFormat } from "./runner-output.js";
import { hostRunnerVersion } from "./runner-version.js";

/** A refused invocation: a command line the parser rejects, or an option the
 *  runner refuses before it starts. */
const EXIT_REFUSED = 2;

interface RunnerArgv {
  port: number;
  /** Turns the per-request log on. */
  verbose: boolean;
  host: string;
  allowRemote: boolean;
  allowOrigin: string[];
  stateDir?: string;
  output: OutputFormat;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The port every Telo runner listens on unless told otherwise. */
const DEFAULT_PORT = 8061;

/** How long a shutdown waits for in-flight HTTP requests to finish before it
 *  stops waiting. Every run has ended by then; what remains is a client holding
 *  a stream open. */
const DRAIN_TIMEOUT_MS = 3_000;

/** Parse the runner's command line and serve. A usage error prints the usage and
 *  the reason on stderr and exits {@link EXIT_REFUSED}; `--help` prints it on stdout. */
export async function runHostRunner(args: readonly string[]): Promise<void> {
  const parsed = await parseCommandLine(args);
  if (parsed === undefined) return;
  await serve(parsed);
}

function parseCommandLine(args: readonly string[]): Promise<RunnerArgv | undefined> {
  const parser = yargs([...args])
    .scriptName("telo-host-runner")
    .usage(
      "$0 [options]\n\nServe the /v1 runner API over local processes, so an editor (or any client) can run applications on this machine. " +
        "`telo-host-runner telo <arguments>` runs the telo it bundles.",
    )
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
      describe: "Permit a non-loopback bind. Everyone who can reach the port can run code as this user.",
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
    })
    .option("verbose", {
      type: "boolean",
      default: false,
      describe: "Turn the per-request log on.",
    })
    .option("output", {
      alias: "o",
      type: "string",
      choices: OUTPUT_FORMATS,
      default: "text" as const,
      describe: "Output format. `json` prints the address the runner serves as one document on stdout.",
    })
    .strict()
    .help()
    .version(false)
    .exitProcess(false);

  return new Promise((resolve) => {
    parser.parse(args as string[], {}, (err: Error | undefined, argv: unknown, output: string) => {
      if (err) {
        outErrLine(output || err.message);
        process.exitCode = EXIT_REFUSED;
        resolve(undefined);
        return;
      }
      if (output) {
        // `--help`: the usage is the answer.
        process.stdout.write(`${output}\n`);
        resolve(undefined);
        return;
      }
      resolve(argv as unknown as RunnerArgv);
    });
  });
}

async function serve(argv: RunnerArgv): Promise<void> {
  configureOutput(argv.output);

  // A non-loopback bind is refused rather than warned about: this API starts
  // processes as the invoking user and authenticates nobody, so exposing it is
  // a decision, not a default.
  if (!LOOPBACK.has(argv.host) && !argv.allowRemote) {
    outErrLine(
      `telo-host-runner: refusing to bind ${argv.host}. This API runs applications as ${os.userInfo().username} ` +
        `with no authentication, so a non-loopback bind must be asked for explicitly: pass --allow-remote.`,
    );
    process.exitCode = EXIT_REFUSED;
    return;
  }

  if (!Number.isInteger(argv.port) || argv.port < 0 || argv.port > 65535) {
    outErrLine(`telo-host-runner: --port must be 0 (pick a free one) or 1..65535, got '${argv.port}'.`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const refusal = containerRunnerSettingRefusal(process.env, os.userInfo().username);
  if (refusal) {
    outErrLine(`telo-host-runner: ${refusal}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  // The co-resident agent, from the operator's `AGENT_*` variables.
  let agent: RunnerAgent | undefined;
  try {
    agent = loadLocalAgent(process.env);
  } catch (err) {
    outErrLine(`telo-host-runner: ${message(err)}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const resolution = resolveStateRoot(argv.stateDir, process.env, process.platform, process.cwd());
  if ("refusal" in resolution) {
    outErrLine(`telo-host-runner: ${resolution.refusal}`);
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
      `telo-host-runner: cannot keep state in '${stateRoot}' (${source}): ${message(err)}. ` +
        `Name a writable directory with --state-dir <dir> or ${STATE_DIR_ENV}.`,
    );
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const backend = createProcessBackend({
    stateRoot,
    telo: createTeloSupply({
      identity: TELO_RUNTIME_VERSION,
      hostTarget: hostReleaseTarget(),
      cacheRoot: carriersRoot(),
    }),
    onSwept: (names) =>
      outErrLine(
        `telo-host-runner: removed ${names.length} session director${names.length === 1 ? "y" : "ies"} no stored session owns.`,
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
  let rootSecretSeed: ReturnType<typeof loadRootSecretSeed>;
  try {
    base = loadCoreConfig(process.env, {
      port: argv.port > 0 ? argv.port : DEFAULT_PORT,
      stateDir: stateRoot,
    });
    rootSecretSeed = loadRootSecretSeed(process.env, base.sessionStore);
  } catch (err) {
    outErrLine(`telo-host-runner: ${message(err)}`);
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
        outErrLine(`telo-host-runner: ${msg}: ${message((detail as { err?: unknown }).err ?? detail)}`),
    },
  }).catch((err: unknown) => {
    outErrLine(`telo-host-runner: could not open the session store: ${message(err)}`);
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
      rootSecretSeed,
      version: hostRunnerVersion() ?? "unversioned build",
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
    outErrLine(`telo-host-runner: ${message(err)}`);
    process.exitCode = 1;
    return;
  }
  const { app, lifecycle } = server;

  try {
    await app.listen({ port: argv.port, host: argv.host });
  } catch (err) {
    outErrLine(`telo-host-runner: could not listen on ${argv.host}:${argv.port}: ${message(err)}`);
    await app.close();
    await store.close();
    process.exitCode = 1;
    return;
  }

  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : argv.port;
  const url = `http://${argv.host === "::1" ? "[::1]" : argv.host}:${port}`;

  outLine(`telo-host-runner listening on ${url}`);
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
    outErrLine(`telo-host-runner: stopped (${signal}).`);
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
