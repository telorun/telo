import type { Argv } from "yargs";
import {
  composeApplicationDocument,
  componentCount,
  incompleteModules,
} from "../bill-of-materials/composed-document.js";
import { printClosureDiagnostics, countLine, printClosureRefusals } from "../bill-of-materials/closure-report.js";
import { incompleteRecordDiagnostic } from "../bill-of-materials/incomplete-records.js";
import { buildApplicationClosure } from "../bill-of-materials/module-closure.js";
import {
  describeOccurrenceScope,
  parseOccurrenceScope,
  type OccurrenceScope,
} from "../bill-of-materials/platform-scope.js";
import { EXIT_REFUSED } from "../exit-status.js";
import { createLogger, type Logger } from "../logger.js";
import { outErrLine, output } from "../output.js";

/** The sentence both commands' help opens with. */
export const SBOM_DEFINITION =
  "A software bill of materials (SBOM) is the list of every third-party component a piece of " +
  "software ships, each with its exact version and package URL, which vulnerability scanners " +
  "match against advisory databases.";

export const PLATFORM_OPTION = {
  type: "string",
  describe:
    "Keep only what a platform loads, as os/arch[/libc] (e.g. linux/amd64/gnu). An axis left out " +
    "keeps every value; omitted, every selector is listed.",
} as const;

export const ABI_OPTION = {
  type: "string",
  describe:
    "Keep only what a runtime ABI loads, as <family>-<version> (e.g. node-141). Omitted, every abi is " +
    "listed — unlike telo install, which then skips abi layers.",
} as const;

/** The scope two flags name, or a refused invocation (exit 2). */
export function scopeOrRefuse(argv: { platform?: string; abi?: string }, log: Logger): OccurrenceScope | undefined {
  try {
    return parseOccurrenceScope(argv.platform, argv.abi);
  } catch (err) {
    outErrLine(`${log.err.error("error")}  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT_REFUSED;
    return undefined;
  }
}

export async function sbom(argv: {
  manifest: string;
  platform?: string;
  abi?: string;
  allowIncomplete?: boolean;
}): Promise<void> {
  const log = createLogger(false);
  const scope = scopeOrRefuse(argv, log);
  if (!scope) return;
  const allowIncomplete = argv.allowIncomplete === true;

  const outcome = await buildApplicationClosure({ manifest: argv.manifest, scope, log });
  if (!outcome.ok) {
    printClosureRefusals(outcome.refusals, log);
    process.exitCode = 1;
    return;
  }
  const { closure } = outcome;
  const unrecorded = incompleteModules(closure);
  if (unrecorded.length > 0) {
    const counts = printClosureDiagnostics(
      unrecorded.map((node) => ({
        graph: node.anchor.graph,
        entryPath: node.anchor.entryPath,
        diagnostics: [incompleteRecordDiagnostic(node, allowIncomplete)],
      })),
      log,
    );
    if (!allowIncomplete) {
      outErrLine(countLine(counts, log));
      process.exitCode = 1;
      return;
    }
  }

  output().raw(composeApplicationDocument(closure));
  const modules = closure.modules.length;
  const components = componentCount(closure);
  outErrLine(
    `${closure.entry.subject.name}: ${modules} module${modules === 1 ? "" : "s"}, ` +
      `${components} component${components === 1 ? "" : "s"}, ${describeOccurrenceScope(scope)}` +
      (unrecorded.length > 0 ? `, ${unrecorded.length} incomplete` : ""),
  );
}

export function sbomCommand(yargs: Argv): Argv {
  return yargs.command(
    "sbom <manifest>",
    `${SBOM_DEFINITION} Writes one CycloneDX 1.6 document covering an application's whole module closure — ` +
      "its own modules, every import, the modules nested in one and every child application — to stdout, " +
      "and a summary to stderr.",
    (y) =>
      y
        .positional("manifest", {
          describe: "Path to a YAML manifest, a directory containing telo.yaml, a packaged executable, or an HTTP(S) URL",
          type: "string",
          demandOption: true,
        })
        .option("platform", PLATFORM_OPTION)
        .option("abi", ABI_OPTION)
        .option("allow-incomplete", {
          type: "boolean",
          default: false,
          describe:
            "Write the document past each module with no complete record, marking it incomplete in " +
            "compositions and reporting it as a warning, instead of refusing",
        }),
    async (argv) => {
      await sbom(argv as never);
    },
  );
}
