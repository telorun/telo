// FIRST: takes TELO_APP_CLI out of the environment before anything reads it.
import { APP_CLI_ENV, appCliSwitch } from "../app-cli-switch.js";
import { EXIT_REFUSED } from "../exit-status.js";
import { hideBin } from "yargs/helpers";
import { APP_INFO_ENV } from "../package/app-home.js";
import { carriesPayload } from "../package/app-trailer.js";
import { outErrLine } from "../output.js";
import { installStandaloneRuntime } from "./standalone-runtime.js";

/**
 * The single-file executable's entry point.
 *
 * It exists to do two things before anything else runs: tell the kernel where
 * the things a binary cannot resolve for itself will come from, and decide
 * whether this start is an application or the CLI.
 *
 * A carrier with a payload IS that application — every argument belongs to it —
 * unless `TELO_APP_CLI=1` makes it the CLI for this process. The application
 * start is exactly `TELO_APP_CLI=1 <binary> run <binary> <args>`: `telo run`'s
 * own implementation, handed this executable as its manifest, so a packaged
 * service gets the same resolution, signal handling, teardown and exit code as
 * one started from a manifest. A carrier without one is an ordinary `telo`: the
 * CLI is imported and behaves exactly as it does from an npm install, which is
 * what keeps a command from working in one distribution and not the other.
 *
 * The imports of the CLI and the run are dynamic and the work unawaited rather
 * than static, for two reasons that point the same way: a static import is
 * hoisted above the call below, so the CLI would start before the runtime was
 * registered, and top-level `await` cannot be compiled to the CommonJS form the
 * executable is built in.
 */
installStandaloneRuntime();

void (async () => {
  if (appCliSwitch.kind === "refused") {
    outErrLine(appCliSwitch.message);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  if (appCliSwitch.kind === "application" && (await carriesPayload(process.execPath))) {
    const binary = process.execPath;
    if (process.env[APP_INFO_ENV]?.trim()) {
      // Retired, and refused rather than ignored: a script that set it expects
      // the index and must not start the service instead.
      outErrLine(
        `${APP_INFO_ENV} is retired, and this executable starts nothing while it is set. ` +
          `To print what it carries, run: ${APP_CLI_ENV}=1 ${binary} package inspect ${binary}`,
      );
      process.exitCode = EXIT_REFUSED;
      return;
    }
    const { run } = await import("../commands/run.js");
    await run({
      path: binary,
      verbose: false,
      debug: false,
      open: true,
      watch: false,
      cacheWrite: true,
      // `hideBin`, so the arguments the application receives are exactly the
      // ones the CLI would have treated as a user's — one answer to where argv
      // starts, whichever distribution is running.
      applicationArgs: hideBin(process.argv),
    });
    return;
  }
  await import("../cli.js");
})().catch((err: unknown) => {
  // The last-resort handler: a rejected bootstrap must not exit 0 with a silent
  // stack swallowed by the runtime's unhandled-rejection default. It goes
  // through the Output seam like every other CLI-owned write — the format has
  // not been selected yet, and stderr is the human surface in both.
  outErrLine(`telo: failed to start: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
