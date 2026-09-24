import type { Options } from "yargs";
import { OUTPUT_FORMATS } from "./output.js";

/** The options every command accepts. Declared once: yargs registers this table
 *  and `run-invocation.ts` reads it to find where a run's own arguments end. */
export const GLOBAL_OPTIONS = {
  verbose: {
    type: "boolean",
    default: false,
    describe: "Enable verbose logging",
  },
  debug: {
    type: "boolean",
    default: false,
    describe: "Enable debug event streaming",
  },
  watch: {
    alias: "w",
    type: "boolean",
    default: false,
    describe: "Watch manifest files and reload on change",
  },
  "cache-write": {
    type: "boolean",
    default: true,
    describe:
      "Persist the analysis/validator cache to disk. Use --no-cache-write for an ephemeral, read-only run (validates in-memory, reads the baked cache but never writes it).",
  },
  output: {
    alias: "o",
    type: "string",
    choices: OUTPUT_FORMATS,
    default: "text" as const,
    describe:
      "Output format for the CLI's own output. `json` is a machine contract and never carries colour. Note `telo run` streams the app's stdout/stderr through untouched — the app picks its own encoding via its `logging:` block.",
  },
} satisfies Record<string, Options>;
