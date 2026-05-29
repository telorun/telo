import type { Environment } from "@marcbachmann/cel-js";
import type { ResourceManifest } from "@telorun/sdk";
import { extractAccessChains, INDEX_SEGMENT, walkCelExpressions } from "@telorun/templating";
import { type AnalysisDiagnostic, DiagnosticSeverity } from "./types.js";

const SOURCE = "telo-analyzer";

/** Module-doc namespaces whose entries are consumed via `<ns>.<name>` CEL
 *  access. One table drives the whole check — adding a namespace is an entry,
 *  not a branch. */
const NAMESPACES = ["variables", "secrets", "ports"] as const;

/**
 * Warn about declared `variables` / `secrets` / `ports` entries that no CEL
 * expression references. A declared-but-unconsumed entry is dead weight at
 * best and misleading at worst (an unbound `ports` entry makes a runner
 * advertise a port the app never listens on).
 *
 * Generic across all three namespaces. References are collected from every CEL
 * expression (both `${{ … }}` and `!cel`, via `walkCelExpressions`) by
 * extracting member-access chains: a `<ns>.<name>` chain marks `<name>` used.
 * Dynamic access (`<ns>[expr]`, or the namespace passed whole, e.g.
 * `keys(variables)`) yields a chain that stops at the namespace root — that
 * can't be attributed to a name, so the whole namespace is conservatively
 * suppressed to avoid false positives.
 *
 * Application-only: an Application's `variables` / `secrets` / `ports` flow
 * exclusively through CEL (into resource fields, or into `Telo.Import` inputs),
 * so unreferenced means dead. A `Telo.Library`'s `variables` / `secrets` are a
 * public input contract consumed by its controllers — invisible to CEL
 * analysis — so they are deliberately not flagged.
 */
export function validateUnusedDeclarations(
  manifests: ResourceManifest[],
  celEnv: Environment,
): AnalysisDiagnostic[] {
  const moduleManifest = manifests.find((m) => m.kind === "Telo.Application") as
    | Record<string, any>
    | undefined;
  if (!moduleManifest) return [];

  const declared = new Map<string, string[]>();
  for (const ns of NAMESPACES) {
    const block = moduleManifest[ns];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const names = Object.keys(block);
      if (names.length > 0) declared.set(ns, names);
    }
  }
  if (declared.size === 0) return [];

  const used = new Map<string, Set<string>>(NAMESPACES.map((ns) => [ns, new Set<string>()]));
  const suppressed = new Set<string>();

  for (const m of manifests) {
    walkCelExpressions(m, "", (expr, _path, engineName) => {
      if (engineName !== "cel") return;
      let ast: unknown;
      try {
        ast = celEnv.parse(expr).ast;
      } catch {
        return; // syntax errors are reported by the CEL engine pass
      }
      for (const chain of extractAccessChains(ast as Parameters<typeof extractAccessChains>[0])) {
        const ns = chain[0];
        if (!used.has(ns)) continue;
        const member = chain[1];
        // No static member after the namespace root — either the namespace is
        // used whole (`keys(ports)` → ["ports"]) or accessed dynamically
        // (`ports[x]` → ["ports", "[*]"]). Neither can be attributed to a
        // declared name, so suppress the namespace rather than false-positive.
        if (member === undefined || member === INDEX_SEGMENT) suppressed.add(ns);
        else used.get(ns)!.add(member);
      }
    });
  }

  const diagnostics: AnalysisDiagnostic[] = [];
  const filePath = (moduleManifest.metadata as { source?: string } | undefined)?.source;
  for (const [ns, names] of declared) {
    if (suppressed.has(ns)) continue;
    const seen = used.get(ns)!;
    for (const name of names) {
      if (seen.has(name)) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        code: "UNUSED_DECLARATION",
        source: SOURCE,
        message: `${ns}.${name} is declared but never referenced in any CEL expression.`,
        data: { filePath, path: `${ns}.${name}` },
      });
    }
  }
  return diagnostics;
}
