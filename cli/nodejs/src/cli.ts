#!/usr/bin/env node

// FIRST, and it must stay first: bridges CLICOLOR_FORCE onto FORCE_COLOR for
// Node's colour libraries before any of them computes a level. See color-bridge.
import "./color-bridge.js";
// Second, before anything reads the environment: takes TELO_APP_CLI out of it.
import { appCliSwitch } from "./app-cli-switch.js";
import { EXIT_REFUSED } from "./exit-status.js";

import { TELO_RUNTIME_VERSION } from "@telorun/kernel";
import yargs, { type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
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
import { runnerCommand } from "./commands/runner.js";
import { searchCommand } from "./commands/search.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { GLOBAL_OPTIONS } from "./global-options.js";
import { configureOutput, exitOnClosedPipe, outErrLine, parseOutputFormat } from "./output.js";
import { splitRunInvocation } from "./run-invocation.js";
import { parseCommandLine } from "./usage-refusal.js";

/** Every top-level command, by name — which is also how a run is told from
 *  another command: a first positional that names none of them is a manifest. */
const COMMANDS: Record<string, (yargs: Argv) => Argv> = {
  builtins: builtinsCommand,
  cel: celCommand,
  changed: changedCommand,
  check: checkCommand,
  describe: describeCommand,
  env: envCommand,
  format: formatCommand,
  install: installCommand,
  migrate: migrateCommand,
  module: moduleCommand,
  needs: needsCommand,
  package: packageCommand,
  publish: publishCommand,
  release: releaseCommand,
  run: (yargs) => runCommand(yargs, invocation.applicationArgs ?? []),
  runner: runnerCommand,
  search: searchCommand,
  upgrade: upgradeCommand,
};

// Everything after a run's manifest path belongs to the application, so yargs
// never sees it — see run-invocation.ts.
let invocation: ReturnType<typeof splitRunInvocation>;

if (appCliSwitch.kind === "refused") {
  outErrLine(appCliSwitch.message);
  process.exitCode = EXIT_REFUSED;
} else {
  invocation = splitRunInvocation(hideBin(process.argv), new Set(Object.keys(COMMANDS)), {
    options: { ...GLOBAL_OPTIONS, ...RUN_OPTIONS },
    optionalValueShapes: RUN_OPTIONAL_VALUE_SHAPES,
  });

  // Not for a run: its streams carry the application's output, and exiting there
  // would skip the kernel's teardown.
  if (invocation.applicationArgs === undefined) {
    exitOnClosedPipe(process.stdout);
    exitOnClosedPipe(process.stderr);
  }

  let cli = yargs(invocation.cliTokens)
    .scriptName("telo")
    .usage("$0 <command> [options]");

  for (const register of Object.values(COMMANDS)) cli = register(cli) as typeof cli;

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
