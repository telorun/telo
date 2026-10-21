import type { Argv } from "yargs";
import { EXIT_REFUSED } from "./exit-status.js";
import { outErrLine } from "./output.js";

/** Thrown out of the parse to stop it once a usage error is reported. */
class UsageRefused extends Error {}

/**
 * The parser's failure hook. A message means the command line itself was
 * refused — an unknown command or flag, a missing argument, a value outside
 * its choices — so the usage and the reason go to stderr and the exit status
 * is {@link EXIT_REFUSED}. No message means a command's handler rejected,
 * which is the command's own failure: the parse rejects with it, unchanged.
 */
function onParseFailure(message: string | null, error: unknown, usage: Argv): void {
  if (message === null) return;
  usage.showHelp((help: string) => outErrLine(help));
  outErrLine("");
  outErrLine(message);
  process.exitCode = EXIT_REFUSED;
  throw new UsageRefused(message);
}

/** Parse the command line and run its command, a usage error exiting
 *  {@link EXIT_REFUSED}. */
export function parseCommandLine(parser: Argv): void {
  let result: unknown;
  try {
    result = parser.fail(onParseFailure).parse();
  } catch (err) {
    if (err instanceof UsageRefused) return;
    throw err;
  }
  if (result instanceof Promise) {
    result.catch((err: unknown) => {
      if (!(err instanceof UsageRefused)) throw err;
    });
  }
}
