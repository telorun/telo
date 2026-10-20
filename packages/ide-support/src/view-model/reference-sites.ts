import { isModuleKind, type AnalysisRegistry, type LoadedModule } from "@telorun/analyzer";
import type { ReferenceSite } from "@telorun/editor-protocol";
import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";

/**
 * Every reference slot written in a module's own resources and in its module
 * document, found through the registry's visitor — the visitor rather than the
 * graph's edges, since a reference to a provider or a type is drawn as no edge.
 *
 * The module document rides along as a resource of its own kind holding the
 * fields an editor edits on it, so its `targets:` are ordinary referrers.
 */
export function referenceSitesOf(registry: AnalysisRegistry, module: LoadedModule): ReferenceSite[] {
  const docs = [module.owner, ...module.partials].flatMap((file) =>
    file.manifests.filter((m): m is ResourceManifest => m !== null),
  );
  const resources = docs.flatMap((doc): ResourceManifest[] => {
    if (typeof doc.kind !== "string" || isModuleKind(doc.kind) || doc.kind === "Telo.Import") return [];
    const name = (doc.metadata as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string") return [];
    const { kind, metadata, ...fields } = doc as unknown as Record<string, unknown>;
    return [{ kind, metadata: { name }, ...fields } as unknown as ResourceManifest];
  });
  const moduleDoc = docs.find((doc) => typeof doc.kind === "string" && isModuleKind(doc.kind));
  if (moduleDoc) resources.push(moduleRootResource(moduleDoc));

  const out: ReferenceSite[] = [];
  registry.visitManifest(
    resources,
    {
      onRef: (e) => {
        const target = refTargetName(e.value);
        const sourceName = e.source.metadata?.name;
        if (target === undefined || typeof e.source.kind !== "string" || typeof sourceName !== "string") return;
        out.push({ source: { kind: e.source.kind, name: sourceName }, path: e.concretePath, target });
      },
    },
    { expand: true, discoverNestedRefs: true },
  );
  return out;
}

/** The module document as the resource an editor edits: its metadata, inline
 *  imports and config, plus `targets` / `ports` / `logging` on an Application
 *  or `exports` on a Library. */
function moduleRootResource(doc: ResourceManifest): ResourceManifest {
  const record = doc as unknown as Record<string, unknown>;
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {
    metadata: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      categories: metadata.categories,
    },
  };
  const imports = inlineImportEntries(record.imports);
  if (imports) fields.imports = imports;
  if (record.variables) fields.variables = record.variables;
  if (record.secrets) fields.secrets = record.secrets;
  if (doc.kind === "Telo.Application") {
    fields.targets = record.targets ?? [];
    if (record.ports) fields.ports = record.ports;
    if (record.logging) fields.logging = record.logging;
  } else if (record.exports) {
    fields.exports = record.exports;
  }
  return { kind: doc.kind, ...fields } as unknown as ResourceManifest;
}

/** The `imports:` map, each entry in its object form. */
function inlineImportEntries(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries: [string, unknown][] = [];
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry =
      typeof value === "string"
        ? { source: value }
        : value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
    if (typeof entry?.source !== "string") continue;
    entries.push([
      alias,
      {
        source: entry.source,
        ...(typeof entry.integrity === "string" ? { integrity: entry.integrity } : {}),
        ...(entry.variables ? { variables: entry.variables } : {}),
        ...(entry.secrets ? { secrets: entry.secrets } : {}),
      },
    ]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The name a reference holds: a `!ref` as written, a legacy string's last
 *  segment, or a `{ kind, name }` object's name. Undefined for an inline
 *  declaration or any other value. */
function refTargetName(value: unknown): string | undefined {
  if (isRefSentinel(value)) return value.source;
  if (typeof value === "string") {
    const lastDot = value.lastIndexOf(".");
    return lastDot > 0 ? value.slice(lastDot + 1) : value;
  }
  if (value && typeof value === "object") {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}
