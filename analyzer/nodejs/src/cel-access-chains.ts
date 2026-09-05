/**
 * What a manifest's CEL READS, as opposed to what its slots reference.
 *
 * A dependency a manifest states without a slot: `!cel "resources.db.dsn"` makes
 * the reader depend on `db` as surely as a `!ref` would, and no reference walk
 * can see it. Two consumers ask for it — the module graph draws it as a `data`
 * edge, and the kernel needs it to know who becomes invalid when a resource is
 * rebuilt — so the extraction is here rather than in either of them.
 *
 * The expensive half is the CEL environment used to parse, which is built once
 * per process and evaluates nothing.
 */
import { extractAccessChains } from "@telorun/templating";
import type { ResourceManifest } from "@telorun/sdk";
import { walkCelExpressions } from "@telorun/templating";
import { buildCelEnvironment } from "./cel-environment.js";

let parseEnv: ReturnType<typeof buildCelEnvironment> | undefined;

/** Access chains an expression reads, or none when it does not parse — a syntax
 *  error is the engine pass's to report, not this one's. */
export function accessChains(source: string): string[][] {
  try {
    parseEnv ??= buildCelEnvironment();
    return extractAccessChains(parseEnv.parse(source).ast);
  } catch {
    return [];
  }
}

/**
 * The bare resource names a manifest's expressions read through
 * `resources.<name>`, deduplicated.
 *
 * Read from the DECLARATION: a compile-eval field is expanded before a
 * controller sees it, so by then `resources.db.dsn` is a literal with nothing
 * left to say where it came from.
 */
export function celResourceReads(manifest: ResourceManifest): string[] {
  const names = new Set<string>();
  walkCelExpressions(manifest as Record<string, unknown>, "", (source: string) => {
    for (const chain of accessChains(source)) {
      if (chain[0] === "resources" && chain.length >= 2 && chain[1]) names.add(chain[1]);
    }
  });
  return [...names];
}
