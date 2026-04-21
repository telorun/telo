#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { checkCommand } from "./commands/check.js";
import { installCommand } from "./commands/install.js";
import { publishCommand } from "./commands/publish.js";
import { runCommand } from "./commands/run.js";

let cli = yargs(hideBin(process.argv))
  .scriptName("telo")
  .usage("$0 <command> [options]");

cli = checkCommand(cli) as typeof cli;
cli = installCommand(cli) as typeof cli;
cli = publishCommand(cli) as typeof cli;
cli = runCommand(cli) as typeof cli;

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
  .demandCommand(1, "Please specify a command or path to run")
  .strict()
  .help()
  .version()
  .parse();
