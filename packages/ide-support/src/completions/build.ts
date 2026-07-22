import { parseToAst, type AnalysisRegistry, type AstDocument, type AstMap } from "@telorun/analyzer";
import type { CompletionResult, IdeEnvironmentAdapter } from "../types.js";
import type { ReplaceRange } from "./detect-context.js";
import { detectContext, lookupRefConstraint } from "./detect-context.js";
import { importSourceCompletions } from "./import-source.js";
import { propKeyCompletions } from "./prop-keys.js";
import { CAPABILITY_VALUES } from "./valid-capabilities.js";

interface ResourceRecord {
  kind: string;
  name: string;
}

/** Read the top-level `kind` and `metadata.name` scalar of each document from
 *  the AST. Consumed only for ref-name completion ranking, so a doc missing
 *  either is simply skipped; the analyzer remains the source of truth. */
function extractInFileResources(docs: AstDocument[]): ResourceRecord[] {
  const out: ResourceRecord[] = [];
  const scalar = (node: { kind: string; value?: unknown } | undefined): string | undefined =>
    node?.kind === "scalar" && typeof node.value === "string" ? node.value : undefined;

  for (const doc of docs) {
    if (doc.root?.kind !== "map") continue;
    let kind: string | undefined;
    let name: string | undefined;
    for (const pair of doc.root.entries) {
      const key = scalar(pair.key);
      if (key === "kind") kind = scalar(pair.value);
      else if (key === "metadata" && pair.value?.kind === "map") {
        const meta = pair.value as AstMap;
        const nameEntry = meta.entries.find((e) => scalar(e.key) === "name");
        name = scalar(nameEntry?.value);
      }
    }
    if (kind && name) out.push({ kind, name });
  }
  return out;
}

/** Returns the resource records whose kind satisfies the slot. When the
 *  slot has a registry-resolvable `x-telo-ref` constraint, results are
 *  filtered to that abstract's implementations; otherwise (or when the
 *  user already typed a sibling `kind:`) they're filtered by an exact
 *  kind match. Falls back to listing every in-file resource so the
 *  user still sees something rather than nothing when the registry
 *  doesn't recognize the kind yet. */
function refNameCompletions(
  docs: AstDocument[],
  refKind: string | undefined,
  refConstraint: string | undefined,
  registry: AnalysisRegistry | undefined,
  replaceRange: ReplaceRange,
): CompletionResult[] {
  const resources = extractInFileResources(docs);
  let acceptable: Set<string> | undefined;

  if (refKind) {
    acceptable = new Set([refKind]);
  } else if (refConstraint && registry) {
    const kinds = registry.userFacingKindsForRef(refConstraint);
    if (kinds) acceptable = new Set(kinds);
  }

  const seen = new Set<string>();
  const out: CompletionResult[] = [];
  for (const r of resources) {
    if (acceptable && !acceptable.has(r.kind)) continue;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push({
      label: r.name,
      kind: "value",
      detail: r.kind,
      // Replace the whole existing value so names with `.`, `-`, or `/` (legal
      // in resource names) overwrite cleanly instead of the trailing word.
      replaceRange,
    });
  }
  return out;
}

/** Resolve the kinds that satisfy the `x-telo-ref` slot at `parentDocKind` +
 *  `parentYamlPath`. Returns `undefined` (caller falls back to the full list)
 *  when there's no constraint, the path doesn't resolve, or the ref can't
 *  be resolved through the registry. */
function refConstrainedKinds(
  registry: AnalysisRegistry,
  parentDocKind: string,
  parentYamlPath: string[],
): string[] | undefined {
  const definition = registry.resolveDefinition(parentDocKind);
  if (!definition?.schema) return undefined;
  const refString = lookupRefConstraint(
    definition.schema as Record<string, any>,
    parentYamlPath,
  );
  if (!refString) return undefined;
  return registry.userFacingKindsForRef(refString);
}

function kindCompletions(
  registry: AnalysisRegistry | undefined,
  docKind: string | undefined,
  yamlPath: string[] | undefined,
  replaceRange: ReplaceRange,
): CompletionResult[] {
  let kinds: Iterable<string>;
  if (registry && docKind && yamlPath && yamlPath.length > 0) {
    const filtered = refConstrainedKinds(registry, docKind, yamlPath);
    kinds = filtered ?? registry.validUserFacingKinds();
  } else if (registry) {
    kinds = registry.validUserFacingKinds();
  } else {
    kinds = ["Telo.Application", "Telo.Library", "Telo.Definition"];
  }
  const seen = new Set<string>();
  const results: CompletionResult[] = [];
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    // Replace the whole existing kind scalar so a pick of `Sql.Connection`
    // over `Sql.Co|nnection` leaves no `nnection` suffix and no `Sql.` prefix
    // duplication (VS Code's default word range stops at the last `.`).
    results.push({ label: kind, kind: "class", detail: "Telo resource kind", replaceRange });
  }
  return results;
}

function capabilityCompletions(): CompletionResult[] {
  return CAPABILITY_VALUES.map((cap) => ({
    label: cap,
    kind: "enumMember",
    detail: "Telo capability",
  }));
}

export async function buildCompletions(
  text: string,
  line: number,
  character: number,
  registry: AnalysisRegistry | undefined,
  adapter?: IdeEnvironmentAdapter,
  docs?: AstDocument[],
): Promise<CompletionResult[]> {
  // Reuse the host's already-parsed AST when it matches the current buffer;
  // otherwise parse once here (Part 1 stands alone). Both `detectContext` and
  // ref-name in-file resource extraction share this single parse.
  const astDocs = docs ?? parseToAst(text);
  const ctx = detectContext(text, line, character, astDocs);
  if (!ctx) return [];
  if (ctx.type === "kind") {
    return kindCompletions(registry, ctx.docKind, ctx.yamlPath, ctx.replaceRange);
  }
  if (ctx.type === "capability") return capabilityCompletions();
  if (ctx.type === "ref-name") {
    const definition = registry?.resolveDefinition(ctx.docKind);
    const refConstraint = definition?.schema
      ? lookupRefConstraint(definition.schema as Record<string, any>, ctx.yamlPath)
      : undefined;
    return refNameCompletions(astDocs, ctx.refKind, refConstraint, registry, ctx.replaceRange);
  }
  if (ctx.type === "field-value") {
    if (ctx.field === "import-source") {
      return importSourceCompletions(ctx.prefix, ctx.replaceRange, adapter);
    }
    return [];
  }
  return propKeyCompletions(ctx.docKind, ctx.yamlPath, ctx.existingKeys, registry);
}
