/**
 * `telo-release` — the release commands over the ecosystems this package ships
 * (npm, cargo, docker, helm). A Telo module is served by `telo release`. The
 * executable (`bin/telo-release.mjs`) runs {@link teloRelease} over the
 * process's arguments and streams.
 */

import yargs from "yargs";
import { SHIPPED_ADAPTERS } from "../index.js";
import { releaseCommands } from "./commands.js";
import type { ReleaseOutput, Style } from "./host.js";
import { SHIPPED_EVIDENCE } from "./index.js";

function palette(stream: NodeJS.WriteStream): Style {
  const on = stream.isTTY === true && !process.env.NO_COLOR;
  const paint = (code: number) => (text: string) => (on ? `\u001b[${code}m${text}\u001b[0m` : text);
  return { ok: paint(32), dim: paint(2), error: paint(31), warn: paint(33) };
}

/** A command line the parser refused: its reason, printed alone, exit status 2. */
class UsageError extends Error {}

/** The process's own streams, colour decided per stream, progress only on a terminal. */
export function terminalOutput(): { output: ReleaseOutput; setJson(json: boolean): void; endProgress(): void } {
  let json = false;
  let progressShown = false;
  const endProgress = () => {
    if (progressShown) process.stderr.write("\r\u001b[K");
    progressShown = false;
  };
  const output: ReleaseOutput = {
    line: (text) => {
      if (!json) process.stdout.write(`${text}\n`);
    },
    errLine: (text) => {
      endProgress();
      process.stderr.write(`${text}\n`);
    },
    emit: (payload) => {
      if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },
    progress: (text) => {
      if (!process.stderr.isTTY) return;
      process.stderr.write(`\r\u001b[K${text}`);
      progressShown = true;
    },
    style: palette(process.stdout),
    errStyle: palette(process.stderr),
  };
  return { output, setJson: (value) => (json = value), endProgress };
}

/**
 * Run one `telo-release` command line, `process.exitCode` carrying its status.
 * A command line the parser refuses — an unknown command or option, a missing
 * argument, a value outside its choices — runs no command: the reason goes to
 * stderr and the status is 2.
 */
export async function teloRelease(
  args: readonly string[],
  output: ReleaseOutput,
  setJson: (json: boolean) => void = () => {},
): Promise<void> {
  const cli = yargs([...args])
    .scriptName("telo-release")
    .option("output", { alias: "o", choices: ["text", "json"] as const, default: "text", describe: "Output format" })
    .middleware((argv) => setJson(argv.output === "json"))
    .strict()
    .help()
    .version(false);
  try {
    await releaseCommands(cli, {
      command: "telo-release",
      adapters: SHIPPED_ADAPTERS,
      evidence: SHIPPED_EVIDENCE,
      ecosystemHosts: { telo: "the `telo` CLI (`telo release`), which serves Telo modules" },
      output: () => output,
    })
      .fail((message, error) => {
        if (error) throw error;
        throw new UsageError(message);
      })
      .parseAsync();
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    output.errLine(err.message);
    process.exitCode = 2;
  }
}
