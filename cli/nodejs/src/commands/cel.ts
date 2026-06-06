import { buildCelEnvironment, celFunctionCatalog, type CelFunctionInfo } from "@telorun/templating";
import { nodeCelHandlers } from "@telorun/kernel";
import type { Argv } from "yargs";

/** JSON.stringify replacer: cel-js ints are BigInt, which JSON can't serialize. */
const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v);

function printFunctions(asJson: boolean): void {
  const catalog = celFunctionCatalog();
  if (asJson) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }

  const byCategory = new Map<string, CelFunctionInfo[]>();
  for (const fn of catalog) {
    const list = byCategory.get(fn.category) ?? [];
    list.push(fn);
    byCategory.set(fn.category, list);
  }

  for (const [category, fns] of byCategory) {
    console.log(`\n${category}`);
    for (const fn of fns) {
      const tags = [
        fn.hostBacked ? "host" : null,
        fn.deterministic ? null : "non-deterministic",
      ].filter(Boolean);
      const suffix = tags.length ? `  [${tags.join(", ")}]` : "";
      console.log(`  ${fn.signature}${suffix}`);
      console.log(`      ${fn.summary}`);
    }
  }
  console.log();
}

function evalExpression(expr: string, contextJson: string | undefined, asJson: boolean): void {
  let context: Record<string, unknown>;
  try {
    context = contextJson ? JSON.parse(contextJson) : {};
  } catch (err) {
    console.error(`Invalid --context JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Real Node handlers so host-backed functions (sha256, base64, …) behave
  // exactly as they would at runtime.
  const env = buildCelEnvironment(nodeCelHandlers);
  let result: unknown;
  try {
    result = env.parse(expr)(context);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(result, bigintReplacer, 2));
  } else {
    console.log(typeof result === "bigint" ? result.toString() : result);
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
