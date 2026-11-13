#!/usr/bin/env node
import { hideBin } from "yargs/helpers";
import { teloRelease, terminalOutput } from "../dist/node/bin.js";

const terminal = terminalOutput();
await teloRelease(hideBin(process.argv), terminal.output, terminal.setJson);
terminal.endProgress();
