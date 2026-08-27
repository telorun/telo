#!/usr/bin/env node

// FIRST, and it must stay first: bridges CLICOLOR_FORCE onto FORCE_COLOR for
// Node's colour libraries before any of them computes a level. See color-bridge.
import "./color-bridge.js";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { OUTPUT_FORMATS, configureOutput, parseOutputFormat } from "./output.js";
import { celCommand } from "./commands/cel.js";
import { checkCommand } from "./commands/check.js";
import { installCommand } from "./commands/install.js";
import { migrateCommand } from "./commands/migrate.js";
import { moduleCommand } from "./commands/module.js";
import { publishCommand } from "./commands/publish.js";
import { releaseCommand } from "./commands/release.js";
import { runCommand } from "./commands/run.js";
import { searchCommand } from "./commands/search.js";
import { upgradeCommand } from "./commands/upgrade.js";

let cli = yargs(hideBin(process.argv))
  .scriptName("telo")
  .usage("$0 <command> [options]");

cli = celCommand(cli) as typeof cli;
cli = checkCommand(cli) as typeof cli;
cli = installCommand(cli) as typeof cli;
cli = migrateCommand(cli) as typeof cli;
cli = moduleCommand(cli) as typeof cli;
cli = publishCommand(cli) as typeof cli;
cli = releaseCommand(cli) as typeof cli;
cli = runCommand(cli) as typeof cli;
cli = searchCommand(cli) as typeof cli;
cli = upgradeCommand(cli) as typeof cli;

cli
  .option("verbose", {
    type: "boolean",
    default: false,
    describe: "Enable verbose logging",
  })
  .option("debug", {
    type: "boolean",
    default: false,
    describe: "Enable debug event streaming",
  })
  .option("snapshot-on-exit", {
    type: "boolean",
    default: false,
    describe: "Capture a snapshot on exit",
  })
  .option("watch", {
    alias: "w",
    type: "boolean",
    default: false,
    describe: "Watch manifest files and reload on change",
  })
  .option("cache-write", {
    type: "boolean",
    default: true,
    describe:
      "Persist the analysis/validator cache to disk. Use --no-cache-write for an ephemeral, read-only run (validates in-memory, reads the baked cache but never writes it).",
  })
  .option("output", {
    alias: "o",
    type: "string",
    choices: OUTPUT_FORMATS,
    default: "text" as const,
    describe:
      "Output format for the CLI's own output. `json` is a machine contract and never carries colour. Note `telo run` streams the app's stdout/stderr through untouched — the app picks its own encoding via its `logging:` block.",
  })
  // Runs before any handler, so a call site deep inside a command reaches the
  // same decision without the format being threaded through every signature.
  .middleware((argv) => configureOutput(parseOutputFormat(argv.output)), true)
  .demandCommand(1, "Please specify a command or path to run")
  .strict()
  .help()
  .version()
  .parse();
