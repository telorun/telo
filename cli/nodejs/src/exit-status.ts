/**
 * The CLI's exit status (`cli/README.md`, "Exit status"): 0 when the command
 * did its work, 1 when the work failed, 2 when the invocation was refused
 * before any work began. `telo run` exits with its application's own status.
 *
 * Dependency-free, because `app-cli-switch.ts` reads it before anything else
 * may load.
 */

/** A refused invocation: a command line the parser rejects, a start
 *  `TELO_APP_CLI` / `TELO_APP_INFO` refuses, an option a command refuses
 *  before it starts. `cli/rust` exits the same. */
export const EXIT_REFUSED = 2;
