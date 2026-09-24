#!/usr/bin/env node

// FIRST, and it must stay first: bridges CLICOLOR_FORCE onto FORCE_COLOR for
// Node's colour libraries before any of them computes a level. See color-bridge.
import "./color-bridge.js";

import yargs, { type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { celCommand } from "./commands/cel.js";
import { changedCommand } from "./commands/changed.js";
import { checkCommand } from "./commands/check.js";
import { installCommand } from "./commands/install.js";
import { migrateCommand } from "./commands/migrate.js";
import { moduleCommand } from "./commands/module.js";
import { packageCommand } from "./commands/package.js";
import { publishCommand } from "./commands/publish.js";
import { releaseCommand } from "./commands/release.js";
import { RUN_OPTIONAL_VALUE_SHAPES, RUN_OPTIONS, runCommand } from "./commands/run.js";
import { runnerCommand } from "./commands/runner.js";
import { searchCommand } from "./commands/search.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { cliVersion } from "./distribution-versions.js";
import { GLOBAL_OPTIONS } from "./global-options.js";
import { configureOutput, parseOutputFormat } from "./output.js";
import { splitRunInvocation } from "./run-invocation.js";

/** Every top-level command, by name — which is also how a run is told from
 *  another command: a first positional that names none of them is a manifest. */
const COMMANDS: Record<string, (yargs: Argv) => Argv> = {
  cel: celCommand,
  changed: changedCommand,
  check: checkCommand,
  install: installCommand,
  migrate: migrateCommand,
  module: moduleCommand,
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
const invocation = splitRunInvocation(hideBin(process.argv), new Set(Object.keys(COMMANDS)), {
  options: { ...GLOBAL_OPTIONS, ...RUN_OPTIONS },
  optionalValueShapes: RUN_OPTIONAL_VALUE_SHAPES,
});

let cli = yargs(invocation.cliTokens)
  .scriptName("telo")
  .usage("$0 <command> [options]");

for (const register of Object.values(COMMANDS)) cli = register(cli) as typeof cli;

cli
  .options(GLOBAL_OPTIONS)
  // Runs before any handler, so a call site deep inside a command reaches the
  // same decision without the format being threaded through every signature.
  .middleware((argv) => configureOutput(parseOutputFormat(argv.output)), true)
  .demandCommand(1, "Please specify a command or path to run")
  .strict()
  .help()
  // The version is this package's own answer rather than yargs' lookup, which
  // walks up from the main module to a `package.json` — a file a single-file
  // executable does not have, where it printed "unknown".
  .version(cliVersion() ?? "unversioned build")
  .parse();
