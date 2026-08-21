import {
  parseToAst,
  type AnalysisRegistry,
  type AstDocument,
  type AstMap,
  type ManifestAnalysis,
} from "@telorun/analyzer";
import type { CompletionResult, IdeEnvironmentAdapter } from "../types.js";
import type { ReplaceRange } from "./detect-context.js";
import { callInputsAt } from "./call-inputs.js";
import { celCompletions } from "./cel-completions.js";
import { docIdentity } from "../doc-identity.js";
import { detectContext, lookupRefConstraints, navigateSchema } from "./detect-context.js";
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
  refConstraints: string[],
  registry: AnalysisRegistry | undefined,
  replaceRange: ReplaceRange,
): CompletionResult[] {
  const resources = extractInFileResources(docs);
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
  const constraints = lookupRefConstraints(
    definition.schema as Record<string, any>,
    parentYamlPath,
    (from) => registry.resolveSchemaFrom(from, parentDocKind),
  );
  if (constraints.length === 0) return undefined;
  const resolved = constraints.map((c) => registry.userFacingKindsForRef(c));
  if (!resolved.some(Boolean)) return undefined;
  return [...new Set(resolved.flatMap((kinds) => kinds ?? []))];
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
    const refConstraints =
      registry && definition?.schema
        ? lookupRefConstraints(definition.schema as Record<string, any>, ctx.yamlPath, (from) =>
            registry.resolveSchemaFrom(from, ctx.docKind),
          )
        : [];
    return refNameCompletions(astDocs, ctx.refKind, refConstraints, registry, ctx.replaceRange);
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
