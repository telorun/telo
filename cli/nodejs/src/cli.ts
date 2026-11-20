#!/usr/bin/env node

// Importing this module runs no command: `main` does. The two side-effecting
// imports below still evaluate with it, ahead of everything that reads the
// environment.
//
// FIRST, and it must stay first: bridges CLICOLOR_FORCE onto FORCE_COLOR for
// Node's colour libraries before any of them computes a level. See color-bridge.
import "./color-bridge.js";
// Second, before anything reads the environment: takes TELO_APP_CLI out of it.
import { appCliSwitch } from "./app-cli-switch.js";
import { EXIT_REFUSED } from "./exit-status.js";

import { TELO_RUNTIME_VERSION } from "@telorun/kernel";
import yargs, { type Argv } from "yargs";
import { authCommand, loginCommand, logoutCommand } from "./commands/auth.js";
import { builtinsCommand } from "./commands/builtins.js";
import { celCommand } from "./commands/cel.js";
import { changedCommand } from "./commands/changed.js";
import { checkCommand } from "./commands/check.js";
import { describeCommand } from "./commands/describe.js";
import { envCommand } from "./commands/env.js";
import { formatCommand } from "./commands/format.js";
import { installCommand } from "./commands/install.js";
import { migrateCommand } from "./commands/migrate.js";
import { moduleCommand } from "./commands/module.js";
import { needsCommand } from "./commands/needs.js";
import { packageCommand } from "./commands/package.js";
import { publishCommand } from "./commands/publish.js";
import { releaseCommand } from "./commands/release.js";
import { RUN_OPTIONAL_VALUE_SHAPES, RUN_OPTIONS, runCommand } from "./commands/run.js";
import { auditCommand } from "./commands/audit.js";
import { sbomCommand } from "./commands/sbom.js";
import { searchCommand } from "./commands/search.js";
import { sharesCommand } from "./commands/shares.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { GLOBAL_OPTIONS } from "./global-options.js";
import { configureOutput, exitOnClosedPipe, outErrLine, parseOutputFormat } from "./output.js";
import { splitRunInvocation } from "./run-invocation.js";
import { defaultCliServices, type CliServices } from "./share/cli-services.js";
import { installStandaloneRuntime } from "./standalone/standalone-runtime.js";
import { parseCommandLine } from "./usage-refusal.js";

/** Every top-level command, by name — which is also how a run is told from
 *  another command: a first positional that names none of them is a manifest.
 *  `applicationArgs` are the arguments after a run's manifest path. */
function commandTable(applicationArgs: readonly string[], services: CliServices): Record<string, (yargs: Argv) => Argv> {
  return {
    audit: auditCommand,
    auth: authCommand(services),
    builtins: builtinsCommand,
    cel: celCommand,
    changed: changedCommand,
    check: checkCommand,
    describe: describeCommand,
    env: envCommand,
    format: formatCommand,
    install: installCommand,
    login: loginCommand(services),
    logout: logoutCommand(services),
    migrate: migrateCommand,
    module: moduleCommand,
    needs: needsCommand,
    package: packageCommand,
    publish: publishCommand,
    release: releaseCommand,
    run: (yargs) => runCommand(yargs, applicationArgs, services),
    sbom: sbomCommand,
    search: searchCommand,
    shares: sharesCommand(services),
    upgrade: upgradeCommand,
  };
}

/**
 * Run the CLI on `args` — the arguments after the program name, as `process.argv.slice(2)`
 * holds them. Reports through `process.exitCode` and the `Output` seam, as the `telo`
 * bin does; the work of an asynchronous command continues after `main` returns.
 * `services` is the composition root: what the commands are handed rather than choose.
 */
export function main(args: readonly string[], services: CliServices = defaultCliServices()): void {
  // A no-op outside a single-file executable; an executable embedding the CLI
  // under another entry gets the same runtime the CLI's own supplies.
  installStandaloneRuntime();

  if (appCliSwitch.kind === "refused") {
    outErrLine(appCliSwitch.message);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  // Everything after a run's manifest path belongs to the application, so yargs
  // never sees it — see run-invocation.ts.
  const invocation = splitRunInvocation(args, new Set(Object.keys(commandTable([], services))), {
    options: { ...GLOBAL_OPTIONS, ...RUN_OPTIONS },
    optionalValueShapes: RUN_OPTIONAL_VALUE_SHAPES,
  });
  const commands = commandTable(invocation.applicationArgs ?? [], services);

  // Not for a run: its streams carry the application's output, and exiting there
  // would skip the kernel's teardown.
  if (invocation.applicationArgs === undefined) {
    exitOnClosedPipe(process.stdout);
    exitOnClosedPipe(process.stderr);
  }

  let cli = yargs(invocation.cliTokens)
    .scriptName("telo")
    .usage("$0 <command> [options]");

  for (const register of Object.values(commands)) cli = register(cli) as typeof cli;

  parseCommandLine(
    cli
      .options(GLOBAL_OPTIONS)
      // Runs before any handler, so a call site deep inside a command reaches the
      // same decision without the format being threaded through every signature.
      // After validation, so a value outside `--output`'s choices is a usage error.
      .middleware((argv) => configureOutput(parseOutputFormat(argv.output)))
      .demandCommand(1, "Please specify a command or path to run")
      .strict()
      .help()
      // The telo this is: `X` for a release, `X+unreleased` for a build made while
      // `X` is pending — the identity `Kernel.Starting` and the built-in vocabulary
      // carry. A package number would name a release this working copy is not.
      .version(TELO_RUNTIME_VERSION),
  );
}
