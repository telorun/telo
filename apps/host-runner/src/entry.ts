import { hideBin } from "yargs/helpers";

import { TELO_ARGUMENT } from "./runner/self-invocation.js";

/**
 * The host runner's entry, for the bin script and the single-file executable
 * alike: one executable, two roles.
 *
 * A leading `telo` hands the rest of the command line to the CLI bundled with
 * the runner — how the runner starts each session on its own version, by
 * re-entering itself as `telo-host-runner telo run --watch --inspect <manifest>`.
 * That branch runs before the server stack (fastify, pino, ws) is loaded, so a
 * re-entry starts as fast as a plain `telo`. Anything else is the runner.
 *
 * The work is an unawaited async function rather than top-level `await`, which
 * cannot be compiled to the CommonJS form the single-file executable is built in.
 */
void (async () => {
  const args = hideBin(process.argv);
  if (args[0] === TELO_ARGUMENT) {
    const { main } = await import("@telorun/cli");
    main(args.slice(1));
    return;
  }
  const { runHostRunner } = await import("./runner-command.js");
  await runHostRunner(args);
})().catch((err: unknown) => {
  process.stderr.write(`telo-host-runner: failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
