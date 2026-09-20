import { hideBin } from "yargs/helpers";
import { loadPackagedApp, runPackagedApp } from "../package/run-packaged-app.js";
import { outErrLine } from "../output.js";
import { installStandaloneRuntime } from "./standalone-runtime.js";

/**
 * The single-file executable's entry point.
 *
 * It exists to do two things before anything else runs: tell the kernel where
 * the things a binary cannot resolve for itself will come from, and ask whether
 * this binary carries an application of its own.
 *
 * A carrier with a payload IS that application — every argument belongs to it
 * and the CLI is unreachable — and it runs through `telo run`'s own
 * implementation, so a packaged service gets the same signal handling, the same
 * teardown and the same exit code as one started from a manifest. A carrier
 * without one is an ordinary `telo`: the CLI is imported and behaves exactly as
 * it does from an npm install, which is what keeps a command from working in one
 * distribution and not the other.
 *
 * The imports are dynamic and the work unawaited rather than static, for two
 * reasons that point the same way: a static import is hoisted above the call
 * below, so the CLI would start before the runtime was registered, and top-level
 * `await` cannot be compiled to the CommonJS form the executable is built in.
 */
installStandaloneRuntime();

void (async () => {
  const carried = await loadPackagedApp();
  // `TELO_APP_INFO=1` has already written the index; the process ends by running
  // out of work, so the document is flushed rather than cut off by an exit.
  if (carried.kind === "info") return;
  if (carried.kind === "app") {
    // `hideBin`, so the arguments the application receives are exactly the ones
    // the CLI would have treated as a user's — one answer to where argv starts,
    // whichever distribution is running.
    await runPackagedApp(carried.app, hideBin(process.argv));
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
