import type { Argv } from "yargs";
import { loadAnalyzedGraph, printRefusals } from "../analyzed-graph.js";
import { createLogger } from "../logger.js";
import { outErrLine, outLine, output } from "../output.js";
import { renderOutline } from "../outline-text.js";

/**
 * `telo describe <manifest>` — what an application or library does, read from
 * its manifest with nothing booted: the analysis's outline, as text or as the
 * `outlineVersion: 1` document under `-o json`. A manifest `telo check` refuses
 * has no outline: its errors are printed instead, and the command exits 1.
 */
async function runDescribe(argv: { manifest: string }): Promise<void> {
  const log = createLogger(false);
  const analyzed = await loadAnalyzedGraph(argv.manifest, log);
  if (!analyzed) return;
  const { root, registry, manifests, errors } = analyzed;
  if (!root) {
    outErrLine(
      `${log.err.error("error")}  ${analyzed.entryPath} holds no Telo.Application or Telo.Library — ` +
        `an outline describes a module.`,
    );
    process.exitCode = 1;
    return;
  }
  if (errors.length > 0) {
    printRefusals(analyzed, errors, log, "manifest", "outline");
    return;
  }

  const entryModule = root.metadata?.name as string | undefined;
  const options = { root, ...(entryModule ? { entryModule } : {}) };
  const outline = registry
    .analysisOf(manifests)
    .outline(registry.moduleGraphDeps(manifests, options), options);
  if (output().isJson) {
    output().document(outline);
    return;
  }
  for (const line of renderOutline(outline, output().stdout)) outLine(line);
}

export function describeCommand(yargs: Argv): Argv {
  return yargs.command(
    "describe <manifest>",
    "Describe what an application or library does — its inputs, what it starts, its entry points and how their errors are rendered — with nothing booted",
    (y) =>
      y.positional("manifest", {
        describe: "Path to the manifest, a directory containing telo.yaml, or a packaged executable",
        type: "string",
        demandOption: true,
      }),
    async (argv) => {
      await runDescribe(argv as { manifest: string });
    },
  );
}
