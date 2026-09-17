import {
  buildCelEnvironment,
  celBuiltinFunctions,
  celFunctionCatalog,
  type CelFunctionInfo,
} from "@telorun/templating";
import {
  AnalysisRegistry,
  collectModuleDocuments,
  DiagnosticSeverity,
  flattenForAnalyzer,
  StaticAnalyzer,
} from "@telorun/analyzer";
import { assembleGraphDiagnostics, functionSignature } from "@telorun/ide-support";
import { enableBigIntJson, nodeCelHandlers, nodeHostVersions } from "@telorun/kernel";
import type { ResourceManifest } from "@telorun/sdk";
import type { Argv } from "yargs";
import { cacheTargetFor, loadFreshGraph, openSession, resolveEntryPath } from "../check-session.js";
import { createLogger, resolveLocation } from "../logger.js";
import { output } from "../output.js";

/** A CEL built-in, in the same shape as a catalog entry so one listing covers
 *  both halves of what a manifest may call. `receiver` is what the catalog
 *  cannot express: a built-in is usually a METHOD, and calling it as a global
 *  does not type-check. Leaving them out was the reason an author could read
 *  this command end to end and still write `startsWith(key, 'x')`. */
interface CelBuiltinInfo {
  name: string;
  signature: string;
  category: "builtin";
  receiver: string | null;
}

function builtins(): CelBuiltinInfo[] {
  return celBuiltinFunctions().map((fn) => ({
    name: fn.name,
    signature: fn.signature,
    category: "builtin" as const,
    receiver: fn.receiverType,
  }));
}

/** A function a manifest can call through a module — its own through `Self`, an
 *  import's exported ones through the alias — with its derived determinism. The
 *  flags are absent when the analysis derived none: a listing states what was
 *  found, never a default standing in for it. */
interface ModuleFunctionInfo {
  name: string;
  signature: string;
  category: "module";
  receiver: null;
  description?: string;
  deterministic?: boolean;
  hostBacked?: boolean;
  /** The calls to the leaf that makes it non-deterministic, empty when it is not. */
  nondeterministicVia?: string[];
  /** The calls to the leaf that needs the host, empty when it does not. */
  hostBackedVia?: string[];
}

/**
 * The module functions the entry module of `manifests` can call, in receiver
 * order (`Self` first, then each import alias) and declaration order within.
 * Everything here is the analysis's answer — the same resolution `telo check`
 * binds a call through, and the same derived flags it reports.
 */
export function moduleFunctionListing(
  manifests: ResourceManifest[],
  registry: AnalysisRegistry,
): ModuleFunctionInfo[] {
  const root = manifests.find((m) => m.kind === "Telo.Application" || m.kind === "Telo.Library");
  if (!root) return [];
  const scope = registry.analysisOf(manifests).celScope.scopeAt(root, "");
  const ownName = root.metadata?.name;
  const receivers = [...scope.moduleNames]
    .filter((receiver) => receiver !== ownName)
    .sort((a, b) => (a === "Self" ? -1 : b === "Self" ? 1 : a.localeCompare(b)));
  const out: ModuleFunctionInfo[] = [];
  for (const receiver of receivers) {
    for (const { name, function: fn } of scope.moduleFunctionsOf(receiver)) {
      const qualified = `${receiver}.${name}`;
      const flags = scope.moduleCallFlags(qualified);
      const description = (fn.manifest.metadata as { description?: unknown } | undefined)?.description;
      out.push({
        name: qualified,
        signature: functionSignature(qualified, fn).label,
        category: "module",
        receiver: null,
        ...(typeof description === "string" && description ? { description } : {}),
        ...(flags
          ? {
              deterministic: flags.deterministic,
              hostBacked: flags.hostBacked,
              nondeterministicVia: [...flags.nondeterministicVia],
              hostBackedVia: [...flags.hostBackedVia],
            }
          : {}),
      });
    }
  }
  return out;
}

/** The `--json` document: Telo's catalog followed by CEL's built-ins. Exported
 *  for tests — the listing is what every new CEL diagnostic points a reader at,
 *  so "does it contain the functions those diagnostics are about" is worth
 *  asserting without spawning a CLI. */
export function functionListing(): (CelFunctionInfo | CelBuiltinInfo)[] {
  return [...celFunctionCatalog(), ...builtins()];
}

/**
 * The analyzed manifest set of `manifestPath`, loaded and analyzed exactly as
 * `telo check` does — through the manifest cache, with mutable tags revalidated —
 * and refusing one that did not load or that analysis reports errors in: a
 * listing computed over a partial graph, or over a call that did not resolve,
 * would omit functions silently.
 */
export async function analyzedManifests(
  manifestPath: string,
): Promise<{ manifests: ResourceManifest[]; registry: AnalysisRegistry }> {
  const entryPath = resolveEntryPath(manifestPath);
  const target = cacheTargetFor(entryPath);
  const session = openSession(target ? [target] : []);
  const { graph } = await loadFreshGraph(entryPath, session, createLogger(false));
  if (graph.errors.length > 0) {
    throw new Error(
      `${manifestPath} did not load: ${graph.errors.map((e) => e.error.message).join("; ")}`,
    );
  }
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  const analysis = new StaticAnalyzer().analyze(
    manifests,
    { moduleDocuments: collectModuleDocuments(graph), hostVersions: nodeHostVersions() },
    registry,
  );
  const errors = assembleGraphDiagnostics(graph, analysis).diagnostics.filter(
    (d) => (d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error,
  );
  if (errors.length > 0) {
    const lines = errors.map((d) => {
      const at = resolveLocation(graph, d, entryPath);
      return `  ${at ? `${at}  ` : ""}${d.message}${d.code ? `  ${String(d.code)}` : ""}`;
    });
    throw new Error(
      `${manifestPath} has ${errors.length} error${errors.length === 1 ? "" : "s"} — \`telo check\` reports the same; fix them before listing its functions:\n${lines.join("\n")}`,
    );
  }
  return { manifests, registry };
}

async function printFunctions(asJson: boolean, manifestPath: string | undefined): Promise<void> {
  const catalog = celFunctionCatalog();
  const out = output();
  let moduleFunctions: ModuleFunctionInfo[] = [];
  if (manifestPath) {
    try {
      const { manifests, registry } = await analyzedManifests(manifestPath);
      moduleFunctions = moduleFunctionListing(manifests, registry);
    } catch (err) {
      out.errLine(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  // `--json` predates the global flag and is an alias for it. The array IS the
  // contract, so it is emitted bare rather than inside an envelope. Built-ins
  // are appended rather than merged into a new shape: a consumer reading
  // `signature` and `name` keeps working, and one reading `category` sees a
  // new value rather than a changed one. A manifest's own functions lead, under
  // the `module` category.
  if (asJson || out.isJson) {
    out.document([...moduleFunctions, ...functionListing()]);
    return;
  }

  if (moduleFunctions.length > 0) {
    out.line(`\nfunctions of ${manifestPath}`);
    for (const fn of moduleFunctions) {
      const via = (chain: string[] | undefined) => (chain?.length ? `: ${chain.join(" → ")}` : "");
      const tags = [
        fn.hostBacked === true ? `host${via(fn.hostBackedVia)}` : null,
        fn.deterministic === false ? `non-deterministic${via(fn.nondeterministicVia)}` : null,
      ].filter(Boolean);
      out.line(`  ${fn.signature}${tags.length ? `  [${tags.join(", ")}]` : ""}`);
      if (fn.description) out.line(`      ${fn.description}`);
    }
  }

  const byCategory = new Map<string, CelFunctionInfo[]>();
  for (const fn of catalog) {
    const list = byCategory.get(fn.category) ?? [];
    list.push(fn);
    byCategory.set(fn.category, list);
  }

  for (const [category, fns] of byCategory) {
    out.line(`\n${category}`);
    for (const fn of fns) {
      const tags = [
        fn.hostBacked ? "host" : null,
        fn.deterministic ? null : "non-deterministic",
      ].filter(Boolean);
      const suffix = tags.length ? `  [${tags.join(", ")}]` : "";
      out.line(`  ${fn.signature}${suffix}`);
      out.line(`      ${fn.summary}`);
    }
  }

  // Grouped by receiver, because the grouping IS the information: everything
  // under `on string` must be called on a value, and the globals must not be.
  const byReceiver = new Map<string, string[]>();
  for (const fn of builtins()) {
    const key = fn.receiver ?? "";
    const list = byReceiver.get(key) ?? [];
    list.push(fn.signature);
    byReceiver.set(key, list);
  }
  out.line("\nCEL built-ins (provided by CEL itself)");
  for (const [receiver, signatures] of [...byReceiver].sort(([a], [b]) => a.localeCompare(b))) {
    out.line(`  ${receiver === "" ? "global functions" : `on ${receiver}`}`);
    for (const signature of signatures.sort()) out.line(`      ${signature}`);
  }
  out.line();
}

function evalExpression(expr: string, contextJson: string | undefined, asJson: boolean): void {
  // The one command that evaluates CEL without a kernel, so it installs the
  // int64 JSON encoding itself — `telo cel eval --json 'size([1,2,3])'` has to
  // print what the same expression produces in a run. Every other path reaches
  // it through `boot()`, which is what keeps the CLI and an embedding Node app
  // identical: hosting a kernel is the only thing that installs it.
  enableBigIntJson();

  const out = output();
  let context: Record<string, unknown>;
  try {
    context = contextJson ? JSON.parse(contextJson) : {};
  } catch (err) {
    const message = `Invalid --context JSON: ${err instanceof Error ? err.message : String(err)}`;
    // Prose on stderr plus a non-zero exit — never an envelope on stdout.
    // stdout is the document, and an error object there would be
    // indistinguishable from a CEL expression that evaluated to one.
    out.errLine(message);
    process.exit(1);
  }

  // Real Node handlers so host-backed functions (sha256, base64, …) behave
  // exactly as they would at runtime.
  const env = buildCelEnvironment(nodeCelHandlers);
  let result: unknown;
  try {
    result = env.parse(expr)(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Prose on stderr plus a non-zero exit — never an envelope on stdout.
    // stdout is the document, and an error object there would be
    // indistinguishable from a CEL expression that evaluated to one.
    out.errLine(message);
    process.exit(1);
  }

  // The evaluated value IS the contract — emitted bare, exactly as `--json`
  // already did, so the int64 encoding installed above stays observable.
  if (asJson || out.isJson) {
    out.document(result);
  } else {
    out.line(String(typeof result === "bigint" ? result.toString() : result));
  }
}

export function celCommand(yargs: Argv): Argv {
  return yargs.command("cel", "Inspect and evaluate Telo's CEL environment", (cel) =>
    cel
      .command(
        "functions [manifest]",
        "List the CEL functions available in manifests — and, given a manifest, the module functions it can call",
        (y) =>
          y
            .positional("manifest", {
              describe: "A manifest whose callable module functions to list, with their determinism",
              type: "string",
            })
            .option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) => printFunctions(Boolean(argv.json), argv.manifest as string | undefined),
      )
      .command(
        "eval <expression>",
        "Evaluate a CEL expression (the body of a !cel scalar)",
        (y) =>
          y
            .positional("expression", {
              describe: "CEL expression, e.g. \"now()\" or \"1 + 2\"",
              type: "string",
              demandOption: true,
            })
            .option("context", {
              type: "string",
              describe: 'JSON object of in-scope variables, e.g. \'{"variables":{"x":1}}\'',
            })
            .option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) =>
          evalExpression(
            String(argv.expression),
            argv.context as string | undefined,
            Boolean(argv.json),
          ),
      )
      .demandCommand(1, "Specify a cel subcommand: functions or eval"),
  );
}
