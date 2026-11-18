import type { ShareSummary } from "@telorun/runner-protocol";
import type { Argv } from "yargs";

import { createLogger } from "../logger.js";
import { outErrLine, outLine, output } from "../output.js";
import { defaultCliServices, type CliServices } from "../share/cli-services.js";
import { deleteShare, listShares, readSharesFeature, type RunnerClientOptions } from "../share/runner-client.js";
import { refusalOfSignIn, ShareRefusal } from "../share/share-refusal.js";
import { resolveRunnerUrl } from "../share/share-runner-url.js";
import { SignInError } from "../sign-in/sign-in-error.js";
import { offeringSignIn, terminalSignInOffer } from "../sign-in/sign-in-offer.js";
import type { PromptInput } from "../application-input-prompt.js";

/** Reports a refusal on stderr (and, under `-o json`, in the envelope) and fails the command. */
function refuse(refusal: ShareRefusal): void {
  const log = createLogger(false);
  const [head, ...rest] = refusal.lines(log.err.error("error"));
  outErrLine(head);
  for (const line of rest) outErrLine(line);
  output().emit({ ok: false, code: refusal.refusalCode ?? null, message: refusal.message });
  process.exitCode = 1;
}

/** What decides whether a person is at the terminal to be offered a sign-in. */
export interface SharesTerminal {
  stdin: PromptInput;
  stderr: { isTTY?: boolean };
}

interface SharesArgv {
  runner?: string;
  /** `--no-input`. */
  input?: boolean;
}

async function clientFor(argv: SharesArgv, services: CliServices, terminal: SharesTerminal): Promise<RunnerClientOptions> {
  const client = {
    runnerUrl: resolveRunnerUrl(argv.runner, process.env),
    issuer: services.signIn.issuer,
    credentials: offeringSignIn(services.credentials, services.signIn, terminalSignInOffer({ input: argv.input, stdin: terminal.stdin, stderr: terminal.stderr })),
  };
  await readSharesFeature(client);
  return client;
}

/** `telo shares list`: the signed-in user's shares, newest activity first. */
export async function runSharesList(argv: SharesArgv, services: CliServices, terminal: SharesTerminal = process): Promise<void> {
  try {
    const { shares } = await listShares(await clientFor(argv, services, terminal));
    output().emit({ ok: true, shares });
    for (const line of sharesTable(shares)) outLine(line);
  } catch (error) {
    refuseOrThrow(error);
  }
}

/** `telo shares delete <id>`. */
export async function runSharesDelete(argv: SharesArgv & { id: string }, services: CliServices, terminal: SharesTerminal = process): Promise<void> {
  try {
    await deleteShare(await clientFor(argv, services, terminal), argv.id);
    output().emit({ ok: true, deleted: argv.id });
    outLine(`Deleted share ${argv.id}`);
  } catch (error) {
    refuseOrThrow(error);
  }
}

function refuseOrThrow(error: unknown): void {
  if (error instanceof SignInError) refuse(refusalOfSignIn(error));
  else if (error instanceof ShareRefusal) refuse(error);
  else throw error;
}

function sharesTable(shares: readonly ShareSummary[]): string[] {
  const rows = [
    ["ID", "NAME", "APPLICATION", "CONNECTED", "LAST ACTIVE"],
    ...shares.map((share) => [share.id, share.name, share.application, share.connected ? "yes" : "no", share.lastActiveAt]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]! + 2))).join(""));
}

export function sharesCommand(services: CliServices = defaultCliServices()): (yargs: Argv) => Argv {
  const runner = {
    runner: {
      type: "string",
      requiresArg: true,
      describe: "The runner to ask: --runner, else TELO_RUNNER_URL, else https://runner.telo.run.",
    },
    input: {
      type: "boolean",
      default: true,
      describe: "At a terminal, offer to sign in when no sign-in covers the runner. Use --no-input to refuse instead.",
    },
  } as const;
  return (yargs) =>
    yargs.command(
      "shares <subcommand>",
      "List or delete the shares `telo run --share` took on a runner",
      (y) =>
        y
          .command(
            "list",
            "List your shares on a runner, newest activity first",
            (yy) => yy.options(runner),
            async (argv) => {
              await runSharesList(argv as SharesArgv, services);
            },
          )
          .command(
            "delete <id>",
            "Delete a share; a run holding it ends",
            (yy) => yy.options(runner).positional("id", { describe: "The share's id", type: "string", demandOption: true }),
            async (argv) => {
              await runSharesDelete(argv as unknown as SharesArgv & { id: string }, services);
            },
          )
          .demandCommand(1, "Specify a shares subcommand (list, delete)"),
      () => {},
    );
}
