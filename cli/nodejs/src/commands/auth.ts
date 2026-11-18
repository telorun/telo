import type { Argv } from "yargs";

import { outErrLine, output } from "../output.js";
import { defaultCliServices, type CliServices } from "../share/cli-services.js";
import { resolveRunnerUrl } from "../share/share-runner-url.js";
import { SignInError } from "../sign-in/sign-in-error.js";
import { accountLabel, signInAtTerminal, signInErrorLines } from "../sign-in/sign-in-session.js";
import type { SignInStatus } from "../sign-in/runner-sign-in.js";

/** Reports a failure on stderr, and fails the command. */
function fail(error: SignInError): void {
  for (const line of signInErrorLines(output().stderr.error("error"), error.code, error.message, error.hints)) outErrLine(line);
  process.exitCode = 1;
}

function printSignedIn(status: SignInStatus): void {
  outErrLine(`Signed in to ${status.issuer} as ${accountLabel(status.account!)}`);
  if (status.resources) {
    outErrLine(`  cloud ${status.resources.cloud}`);
    outErrLine(`  runner ${status.resources.runner}`);
  }
}

/** `telo auth login` (and `telo login`): signs this machine in to Telo Cloud and the runner. */
export async function runAuthLogin(argv: { runner?: string; deviceCode?: boolean }, services: CliServices): Promise<void> {
  try {
    const status = await signInAtTerminal(services.signIn, {
      runnerUrl: resolveRunnerUrl(argv.runner, process.env),
      ...(argv.deviceCode ? { deviceCode: true } : {}),
    });
    output().emit(status);
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    fail(error);
    output().emit({
      ok: false,
      signedIn: await recordStored(services),
      issuer: services.signIn.issuer,
      account: null,
      resources: null,
      verified: false,
      problem: { code: error.code ?? null, message: error.message },
    });
  }
}

/** Whether a sign-in is stored; `false` when the store cannot be read. */
async function recordStored(services: CliServices): Promise<boolean> {
  try {
    return await services.signIn.hasSignIn();
  } catch {
    return false;
  }
}

/** `telo auth logout` (and `telo logout`): revokes the sign-in at accounts and forgets it here. */
export async function runAuthLogout(services: CliServices): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort(new SignInError(undefined, "logout cancelled"));
  process.once("SIGINT", onInterrupt);
  try {
    const result = await services.signIn.logout({ signal: controller.signal });
    if (result.outcome === "not-signed-in") {
      outErrLine(`Not signed in to ${result.issuer}; nothing to sign out of.`);
      output().emit({ ok: true, signedIn: false, issuer: result.issuer });
    } else if (result.outcome === "signed-out") {
      outErrLine(`Signed out of ${result.issuer} (was ${accountLabel(result.account)})`);
      output().emit({ ok: true, signedIn: false, issuer: result.issuer });
    } else {
      fail(result.error);
      output().emit({ ok: false, signedIn: false, issuer: result.issuer, problem: { code: result.error.code, message: result.error.message } });
    }
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    fail(error);
    output().emit({ ok: false, signedIn: await recordStored(services), issuer: services.signIn.issuer, problem: { code: error.code ?? null, message: error.message } });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

/** `telo auth status`: the signed-in account and what it covers, confirmed with accounts. */
export async function runAuthStatus(services: CliServices): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort(new SignInError(undefined, "status cancelled"));
  process.once("SIGINT", onInterrupt);
  try {
    const status = await services.signIn.status({ signal: controller.signal });
    output().emit(status);
    if (status.signedIn) printSignedIn(status);
    else outErrLine(`Not signed in to ${status.issuer}`);
    if (status.problem) {
      const label = status.ok ? output().stderr.warn("warning") : output().stderr.error("error");
      for (const line of signInErrorLines(label, status.problem.code ?? undefined, status.problem.message)) outErrLine(line);
    }
    if (!status.signedIn) outErrLine("  run: telo auth login");
    if (!status.ok) process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    fail(error);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

/** One definition per verb, registered under `telo auth` and, as its alias, at the top level. */
function loginDefinition(services: CliServices) {
  return {
    command: "login",
    describe: "Sign in to Telo Cloud and the runner",
    builder: (yargs: Argv) =>
      yargs
        .option("runner", {
          type: "string",
          requiresArg: true,
          describe: "The runner the sign-in covers: --runner, else TELO_RUNNER_URL, else https://runner.telo.run.",
        })
        .option("device-code", {
          type: "boolean",
          default: false,
          describe: "Sign in with a code entered in any browser, instead of opening one here. Chosen on its own over SSH and where no display is found.",
        }),
    handler: async (argv: unknown) => {
      await runAuthLogin(argv as { runner?: string; deviceCode?: boolean }, services);
    },
  };
}

function logoutDefinition(services: CliServices) {
  return {
    command: "logout",
    describe: "Sign out: revoke the sign-in at accounts and forget it on this machine",
    builder: (yargs: Argv) => yargs,
    handler: async () => {
      await runAuthLogout(services);
    },
  };
}

export function authCommand(services: CliServices = defaultCliServices()): (yargs: Argv) => Argv {
  return (yargs) =>
    yargs.command(
      "auth <subcommand>",
      "Sign in to Telo Cloud and the runner",
      (y) =>
        y
          .command(loginDefinition(services))
          .command(logoutDefinition(services))
          .command(
            "status",
            "Show who is signed in and what the sign-in covers, confirmed with accounts",
            (yy) => yy,
            async () => {
              await runAuthStatus(services);
            },
          )
          .demandCommand(1, "Specify an auth subcommand (login, logout, status)"),
      () => {},
    );
}

/** `telo login`: `telo auth login` under a shorter name. */
export function loginCommand(services: CliServices = defaultCliServices()): (yargs: Argv) => Argv {
  return (yargs) => yargs.command(loginDefinition(services));
}

/** `telo logout`: `telo auth logout` under a shorter name. */
export function logoutCommand(services: CliServices = defaultCliServices()): (yargs: Argv) => Argv {
  return (yargs) => yargs.command(logoutDefinition(services));
}
