#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { celCommand } from "./commands/cel.js";
import { checkCommand } from "./commands/check.js";
import { installCommand } from "./commands/install.js";
import { moduleCommand } from "./commands/module.js";
import { publishCommand } from "./commands/publish.js";
import { runCommand } from "./commands/run.js";
import { searchCommand } from "./commands/search.js";
import { upgradeCommand } from "./commands/upgrade.js";

let cli = yargs(hideBin(process.argv))
  .scriptName("telo")
  .usage("$0 <command> [options]");

cli = celCommand(cli) as typeof cli;
cli = checkCommand(cli) as typeof cli;
cli = installCommand(cli) as typeof cli;
cli = moduleCommand(cli) as typeof cli;
cli = publishCommand(cli) as typeof cli;
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
  .demandCommand(1, "Please specify a command or path to run")
  .strict()
  .help()
  .version()
  .parse();
