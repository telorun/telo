import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { distance } from "./levenshtein.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** The four slots a `Telo.Definition` names its dispatch target in. Each takes
 *  the same grammar; which one is legal for a given capability is
 *  `validate-provider-coherence`'s question, not this one's. */
const DISPATCH_FIELDS = ["invoke", "run", "provide", "mount"] as const;

/**
 * A `!ref` at a definition's dispatch slot must name a sibling `resources:`
 * entry.
 *
 * `!ref` is the one spelling an author — and the editor's rename, completion and
 * go-to-definition — expects to be RESOLVED. But a `Telo.Definition` is in both
 * `REF_VALIDATION_SKIP_KINDS` and `REF_RESOLUTION_SKIP_KINDS`, and the dispatch
 * slots carry no `x-telo-ref` (the accepted targets are the definition's own
 * template-internal entries, not resources of any module), so no reference pass
 * reaches them. Introducing the tag at a slot nothing resolves would be worse
 * than the string form it replaces: a typo that used to be an obvious runtime
 * miss becomes a typo in a construct that advertises static resolution.
 *
 * Decidable only when every sibling name is LITERAL. A template routinely names
 * its entries with CEL (`name: !cel "self.name + '-query'"`), and an expression
 * could expand to the referenced name — so one dynamic sibling switches the
 * check off for that definition rather than inventing a miss.
 *
 * Entry-module-scoped, like every other declaration check: a published
 * dependency's template body is not the consumer's to fix.
 *
 * Browser-safe.
 */
export function validateTemplateDispatch(
  manifests: ResourceManifest[],
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];

  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const meta = m.metadata as { name?: string; module?: string; source?: string } | undefined;
    const name = meta?.name;
    if (!name) continue;
    if (meta?.module && !rootModules.has(meta.module)) continue;

    const bodies = (m as Record<string, unknown>).resources;
    if (!Array.isArray(bodies)) continue;

    const siblings: string[] = [];
    let anyDynamic = false;
    for (const entry of bodies) {
      const entryName = (entry as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
      if (typeof entryName === "string" && !entryName.includes("${{")) siblings.push(entryName);
      else if (entryName !== undefined) anyDynamic = true;
    }
    if (anyDynamic) continue;

    for (const field of DISPATCH_FIELDS) {
      const value = (m as Record<string, unknown>)[field];
      if (!isRefSentinel(value)) continue;
      const source = value.source;
      const target = source.startsWith("Self.") ? source.slice("Self.".length) : source;
      if (siblings.includes(target)) continue;
      const suggestion = nearest(target, siblings);
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "TEMPLATE_DISPATCH_UNKNOWN",
        source: SOURCE,
        message:
          `${m.kind}/${name}: '${field}: !ref ${source}' names no entry in 'resources:'. ` +
          `Available: ${siblings.join(", ") || "(none)"}.` +
          (suggestion ? ` Did you mean '${suggestion}'?` : ""),
        data: {
          resource: { kind: m.kind, name },
          filePath: meta?.source,
          path: field,
          ...(suggestion ? { fix: { replacement: suggestion } } : {}),
        },
      });
    }
  }

  return out;
}

/** The closest sibling name, when one is close enough to be a typo rather than a
 *  different name. */
function nearest(target: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const candidate of candidates) {
    const d = distance(target, candidate);
    if (!best || d < best.d) best = { name: candidate, d };
  }
  const limit = Math.max(1, Math.floor(target.length / 3));
  return best && best.d <= limit ? best.name : undefined;
}
