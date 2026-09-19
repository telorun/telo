import { outErrLine } from "../output.js";
import { installStandaloneRuntime } from "./standalone-runtime.js";

/**
 * The single-file executable's entry point.
 *
 * It exists to do one thing before the CLI runs: tell the kernel where the
 * things a binary cannot resolve for itself will come from. The CLI is then
 * imported and behaves exactly as it does from an npm install — there is no
 * second code path for the standalone build, which is what keeps a command
 * from working in one distribution and not the other.
 *
 * The import is dynamic and unawaited rather than static, for two reasons that
 * point the same way: a static import is hoisted above the call below, so the
 * CLI would start before the runtime was registered, and top-level `await`
 * cannot be compiled to the CommonJS form the executable is built in.
 */
installStandaloneRuntime();

void import("../cli.js").catch((err: unknown) => {
  // The last-resort handler: a rejected bootstrap must not exit 0 with a silent
  // stack swallowed by the runtime's unhandled-rejection default. It goes
  // through the Output seam like every other CLI-owned write — the format has
  // not been selected yet, and stderr is the human surface in both.
  outErrLine(`telo: failed to start: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
