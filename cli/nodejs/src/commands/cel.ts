import { buildCelEnvironment, celFunctionCatalog, type CelFunctionInfo } from "@telorun/templating";
import { enableBigIntJson, nodeCelHandlers } from "@telorun/kernel";
import type { Argv } from "yargs";
import { output } from "../output.js";

function printFunctions(asJson: boolean): void {
  const catalog = celFunctionCatalog();
  const out = output();
  // `--json` predates the global flag and is an alias for it. The catalog array
  // IS the contract, so it is emitted bare rather than inside an envelope.
  if (asJson || out.isJson) {
    out.document(catalog);
    return;
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
        "functions",
        "List the CEL standard-library functions available in manifests",
        (y) =>
          y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) => printFunctions(Boolean(argv.json)),
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
