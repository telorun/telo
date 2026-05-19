import type { AnalysisRegistry } from "@telorun/analyzer";
import type { CompletionResult, IdeEnvironmentAdapter } from "../types.js";
import { detectContext, lookupRefConstraint } from "./detect-context.js";
import { importSourceCompletions } from "./import-source.js";
import { propKeyCompletions } from "./prop-keys.js";
import { CAPABILITY_VALUES } from "./valid-capabilities.js";

interface ResourceRecord {
  kind: string;
  name: string;
}

/** Roughly extract `(kind, metadata.name)` pairs from a multi-doc YAML text.
 *  This is intentionally lightweight: it scans for top-level `kind:` and the
 *  first `name:` under a `metadata:` block per `---`-separated section, with
 *  no full YAML parse. The output is consumed only for completion ranking,
 *  so misses on edge-case manifests are acceptable; the analyzer remains
 *  the source of truth for validation. */
function extractInFileResources(text: string): ResourceRecord[] {
  const out: ResourceRecord[] = [];
  const lines = text.split("\n");
  let currentKind: string | undefined;
  let currentName: string | undefined;
  let inMetadata = false;

  const flush = () => {
    if (currentKind && currentName) {
      out.push({ kind: currentKind, name: currentName });
    }
    currentKind = undefined;
    currentName = undefined;
    inMetadata = false;
  };

  for (const line of lines) {
    if (line.trimEnd() === "---") {
      flush();
      continue;
    }
    const kindMatch = line.match(/^kind:\s*(\S+)/);
    if (kindMatch) {
      currentKind = kindMatch[1];
      continue;
    }
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    if (inMetadata) {
      // Lines inside metadata are indented. Pick the first `name:` we see.
      const nameMatch = line.match(/^\s+name:\s*(\S+)/);
      if (nameMatch && !currentName) {
        currentName = nameMatch[1];
      }
      // Leaving the metadata block — any line that is not indented marks
      // the end of the block.
      if (line.length > 0 && !/^\s/.test(line)) {
        inMetadata = false;
      }
    }
  }
  flush();
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
  text: string,
  refKind: string | undefined,
  refConstraint: string | undefined,
  registry: AnalysisRegistry | undefined,
  valueStartColumn: number,
): CompletionResult[] {
  const resources = extractInFileResources(text);
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
      // Anchor the replace range to the value's start column so names with
      // `.`, `-`, or `/` (legal in resource names) replace the whole typed
      // prefix instead of the trailing word VS Code would pick by default.
      replaceFromColumn: valueStartColumn,
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
  valueStartColumn: number | undefined,
): CompletionResult[] {
  let kinds: Iterable<string>;
  if (registry && docKind && yamlPath && yamlPath.length > 0) {
    const filtered = refConstrainedKinds(registry, docKind, yamlPath);
    kinds = filtered ?? registry.validUserFacingKinds();
  } else if (registry) {
    kinds = registry.validUserFacingKinds();
  } else {
    kinds = ["Telo.Application", "Telo.Library", "Telo.Import", "Telo.Definition"];
  }
  const seen = new Set<string>();
  const results: CompletionResult[] = [];
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    const item: CompletionResult = { label: kind, kind: "class", detail: "Telo resource kind" };
    // Anchor the replace range to the value's start column so kinds with `.`
    // (e.g. `Sql.Connection`) cleanly overwrite the existing prefix. Without
    // this, VS Code's default word boundary stops at the last `.` and a pick
    // of `Sql.Connection` while the buffer reads `Sql.Co|` becomes
    // `Sql.Sql.Connection`.
    if (valueStartColumn !== undefined) item.replaceFromColumn = valueStartColumn;
    results.push(item);
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
): Promise<CompletionResult[]> {
  const ctx = detectContext(text, line, character);
  if (!ctx) return [];
  if (ctx.type === "kind") {
    return kindCompletions(registry, ctx.docKind, ctx.yamlPath, ctx.valueStartColumn);
  }
  if (ctx.type === "capability") return capabilityCompletions();
  if (ctx.type === "ref-name") {
    const definition = registry?.resolveDefinition(ctx.docKind);
    const refConstraint = definition?.schema
      ? lookupRefConstraint(definition.schema as Record<string, any>, ctx.yamlPath)
      : undefined;
    return refNameCompletions(
      text,
      ctx.refKind,
      refConstraint,
      registry,
      ctx.valueStartColumn,
    );
  }
  if (ctx.type === "field-value") {
    if (ctx.docKind === "Telo.Import" && ctx.field === "source") {
      return importSourceCompletions(ctx.prefix, ctx.valueStartColumn, adapter);
    }
    return [];
  }
  return propKeyCompletions(ctx.docKind, ctx.yamlPath, ctx.existingKeys, registry);
}
