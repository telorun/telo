import {
  parseToAst,
  type AnalysisRegistry,
  type AstDocument,
  type AstMap,
  type ManifestAnalysis,
  type RefSlot,
} from "@telorun/analyzer";
import type { CompletionResult, IdeEnvironmentAdapter } from "../types.js";
import type { ReplaceRange } from "./detect-context.js";
import { callInputsAt } from "./call-inputs.js";
import { celCompletions } from "./cel-completions.js";
import { docIdentity } from "../doc-identity.js";
import { detectContext, lookupRefSlot, navigateSchema } from "./detect-context.js";
import { importSourceCompletions } from "./import-source.js";
import { moduleFileCompletions } from "./module-file-completions.js";
import { valueTagCompletions } from "./value-tag-completions.js";
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
  for (const doc of docs) {
    const identity = docIdentity(doc);
    if (identity.kind && identity.name) out.push({ kind: identity.kind, name: identity.name });
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
  slot: RefSlot | undefined,
  registry: AnalysisRegistry | undefined,
  analysis: ManifestAnalysis | undefined,
  replaceRange: ReplaceRange,
): CompletionResult[] {
  const resources = extractInFileResources(docs);
  const refConstraints = slot?.kinds ?? [];
  let acceptable: Set<string> | undefined;

  if (refKind) {
    acceptable = new Set([refKind]);
  } else if (refConstraints.length > 0 && registry) {
    // Union across the slot's accepted kinds: a resource satisfying any one of
    // them fills the slot. A constraint the registry can't resolve contributes
    // nothing rather than narrowing to the ones it could.
    const resolved = refConstraints.map((c) => registry.userFacingKindsForRef(c));
    if (resolved.some(Boolean)) {
      acceptable = new Set(resolved.flatMap((kinds) => kinds ?? []));
    }
  }

  const seen = new Set<string>();
  const out: CompletionResult[] = [];
  for (const r of resources) {
    if (acceptable && !acceptable.has(r.kind)) continue;
    // A target `telo check` refuses for what it returns is not a candidate. The
    // analysis resolves the instance's own contract; without one the kind's
    // decides.
    if (slot && outputRefused(slot, r, registry, analysis)) continue;
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

function outputRefused(
  slot: RefSlot,
  candidate: { kind: string; name?: string },
  registry: AnalysisRegistry | undefined,
  analysis: ManifestAnalysis | undefined,
): boolean {
  if (!slot.outputType) return false;
  const refusal = analysis
    ? analysis.outputRefusal(slot, { kind: candidate.kind, name: candidate.name })
    : (registry?.outputRefusal(slot, { kind: candidate.kind }) ?? []);
  return refusal.length > 0;
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
  const slot = lookupRefSlot(
    definition.schema as Record<string, any>,
    parentYamlPath,
    (from) => registry.resolveSchemaFrom(from, parentDocKind),
  );
  if (!slot || slot.kinds.length === 0) return undefined;
  const resolved = slot.kinds.map((c) => registry.userFacingKindsForRef(c));
  if (!resolved.some(Boolean)) return undefined;
  // An inline declaration of a kind whose output the slot refuses would be
  // refused by `telo check` the moment it is written.
  return [...new Set(resolved.flatMap((kinds) => kinds ?? []))].filter(
    (kind) => !outputRefused(slot, { kind }, registry, undefined),
  );
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

/**
 * The values a field's schema says it may take.
 *
 * `enum` is closed and `examples` open — the same distinction `propertyNames`
 * carries for a map's keys, one level down. Nothing is offered when the schema
 * declares neither, which is most slots.
 */
function valueSuggestions(
  registry: AnalysisRegistry | undefined,
  docKind: string,
  yamlPath: string[],
  replaceRange: ReplaceRange,
): CompletionResult[] {
  const definition = registry?.resolveDefinition(docKind);
  if (!registry || !definition?.schema || yamlPath.length === 0) return [];
  const field = navigateSchema(definition.schema as Record<string, any>, yamlPath, (from) =>
    registry.resolveSchemaFrom(from, docKind),
  );
  if (!field) return [];
  const closed = Array.isArray(field.enum) ? (field.enum as unknown[]) : undefined;
  const values = closed ?? (Array.isArray(field.examples) ? (field.examples as unknown[]) : []);
  return values
    .filter((v) => v !== null && typeof v !== "object")
    .map((value) => ({
      label: String(value),
      kind: "enumMember" as const,
      detail: closed ? "allowed value" : "known value",
      // Whole-value replacement, so picking over a partially typed value leaves
      // no suffix — the rule every other value completion here follows.
      replaceRange,
    }));
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
  /** The host's analysis of the manifests it loaded. Required for anything
   *  that has to resolve against the manifest SET — CEL completion, and a
   *  target's declared inputs. */
  analysis?: ManifestAnalysis,
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
  if (ctx.type === "value-tag") return valueTagCompletions(ctx, registry);
  if (ctx.type === "module-file") {
    return moduleFileCompletions(ctx.names, ctx.prefix, ctx.replaceRange, adapter);
  }
  if (ctx.type === "value-suggestions") {
    return valueSuggestions(registry, ctx.docKind, ctx.yamlPath, ctx.replaceRange);
  }
  if (ctx.type === "cel") {
    return celCompletions(
      text,
      ctx.segment,
      ctx.offset,
      ctx.concretePath,
      docIdentity(astDocs[ctx.docIndex]),
      analysis?.celScope,
    );
  }
  if (ctx.type === "ref-name") {
    const definition = registry?.resolveDefinition(ctx.docKind);
    const slot =
      registry && definition?.schema
        ? lookupRefSlot(definition.schema as Record<string, any>, ctx.yamlPath, (from) =>
            registry.resolveSchemaFrom(from, ctx.docKind),
          )
        : undefined;
    return refNameCompletions(astDocs, ctx.refKind, slot, registry, analysis, ctx.replaceRange);
  }
  if (ctx.type === "field-value") {
    if (ctx.field === "import-source") {
      return importSourceCompletions(ctx.prefix, ctx.replaceRange, adapter);
    }
    return [];
  }
  // A slot that IS an enclosing call's argument map completes from the target's
  // declared inputs rather than from its own (open) schema.
  return propKeyCompletions(
    ctx.docKind,
    ctx.yamlPath,
    ctx.existingKeys,
    registry,
    callInputsAt(
      registry,
      analysis,
      docIdentity(astDocs[ctx.docIndex]).kind ?? ctx.docKind,
      docIdentity(astDocs[ctx.docIndex]).name,
      ctx.concretePath,
    ),
  );
}
