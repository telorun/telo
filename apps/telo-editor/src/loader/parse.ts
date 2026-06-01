import { RegistrySource, isModuleKind } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type {
  ImportKind,
  ModuleKind,
  ParsedImport,
  ParsedManifest,
  ParsedResource,
  WorkspaceAdapter,
} from "../model";
import { isRegistryImportSource } from "./registry";

const registryImportMatcher = new RegistrySource();

export function classifyImport(source: string): ImportKind {
  if (source.startsWith("pkg:") || /^https?:\/\//.test(source)) return "remote";
  if (isRegistryImportSource(source) && registryImportMatcher.supports(source)) return "registry";
  return "local";
}

/** Project a module doc's inline `imports:` map into `ParsedImport[]`. Accepts
 *  both the scalar shorthand (`Alias: source`) and the object form. Mirrors the
 *  kernel/analyzer desugar in `@telorun/analyzer`'s `inlineImportManifests`, but
 *  produces the editor's `ParsedImport` shape (with `inline: true`) rather than
 *  synthetic manifests — the editor round-trips the raw map, never synthetics. */
function parseInlineImports(moduleDoc: Record<string, unknown> | undefined): ParsedImport[] {
  const raw = moduleDoc?.imports;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: ParsedImport[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry =
      typeof value === "string"
        ? { source: value }
        : value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
    const source = entry?.source;
    if (typeof source !== "string") continue;
    out.push({
      name,
      source,
      importKind: classifyImport(source),
      variables: entry!.variables as Record<string, unknown> | undefined,
      secrets: entry!.secrets as Record<string, unknown> | undefined,
      inline: true,
    });
  }
  return out;
}

/** Builds a placeholder manifest for a module whose YAML couldn't be parsed.
 *  Keeps the module visible in the workspace tree so the user can open Source
 *  view and fix the issue. Best-effort name extraction from the raw text; if
 *  that fails too, fall back to the file's parent directory name. */
export async function buildFailureManifest(
  filePath: string,
  error: unknown,
  adapter: WorkspaceAdapter,
): Promise<ParsedManifest> {
  let rawYaml = "";
  try {
    rawYaml = await adapter.readFile(filePath);
  } catch {
    // If we can't even read the raw file, keep rawYaml empty; the source view
    // will show an empty editor and the banner will still explain the error.
  }

  const kindMatch = /^\s*kind:\s*Telo\.(Library|Application)\b/m.exec(rawYaml);
  const kind: ModuleKind = kindMatch?.[1] === "Library" ? "Library" : "Application";

  const nameMatch = /metadata:\s*\n(?:\s+[^\n]*\n)*?\s+name:\s*["']?([^"'\n]+)["']?/m.exec(rawYaml);
  const fallbackName = filePath.split("/").slice(-2, -1)[0] ?? "module";

  const base = {
    filePath,
    metadata: { name: (nameMatch?.[1] ?? fallbackName).trim() },
    imports: [],
    resources: [],
    loadError: error instanceof Error ? error.message : String(error),
    rawYaml,
  };
  if (kind === "Library") {
    return { ...base, kind: "Library" };
  }
  return { ...base, kind: "Application", targets: [] };
}

export function buildParsedManifest(filePath: string, docs: ResourceManifest[]): ParsedManifest {
  const moduleDoc = docs.find((r) => isModuleKind(r.kind));
  const moduleKind: ModuleKind = moduleDoc?.kind === "Telo.Library" ? "Library" : "Application";

  // Authored `Telo.Import` documents. Require string name + source so transient
  // source-view typing (user hasn't finished typing `name:` or `source:` yet)
  // doesn't surface as null-identified ParsedImport entries downstream views crash on.
  const docImports: ParsedImport[] = docs
    .filter((r) => {
      if (r.kind !== "Telo.Import") return false;
      const name = (r.metadata as { name?: unknown } | undefined)?.name;
      const source = (r as Record<string, unknown>).source;
      return typeof name === "string" && typeof source === "string";
    })
    .map((r) => ({
      name: r.metadata.name as string,
      source: (r as Record<string, unknown>).source as string,
      importKind: classifyImport((r as Record<string, unknown>).source as string),
      variables: (r as Record<string, unknown>).variables as Record<string, unknown> | undefined,
      secrets: (r as Record<string, unknown>).secrets as Record<string, unknown> | undefined,
    }));

  // Inline `imports:` map on the module doc. Each value is either a bare source
  // string (shorthand) or the object form. Marked `inline: true` so write-back
  // edits the map entry rather than a separate document.
  const inlineImports = parseInlineImports(moduleDoc as Record<string, unknown> | undefined);

  const imports: ParsedImport[] = [...docImports, ...inlineImports];

  const resources: ParsedResource[] = docs
    // Require a string `kind` and a string `metadata.name` before projecting
    // a doc into the resources array. Transient source-view typing states
    // (e.g. `kind:` with value not yet entered → null, or a kind-less
    // standalone doc) would otherwise produce ParsedResource entries with
    // null/undefined identifiers that downstream views can't render.
    .filter((r) => {
      if (typeof r.kind !== "string") return false;
      if (isModuleKind(r.kind) || r.kind === "Telo.Import") return false;
      const name = (r.metadata as { name?: unknown } | undefined)?.name;
      return typeof name === "string";
    })
    .map((r) => {
      const { kind, metadata, ...rest } = r as Record<string, unknown> & {
        kind: string;
        metadata: { name: string; module?: string; source?: string };
      };
      return {
        kind,
        name: metadata.name,
        module: metadata.module,
        fields: rest as Record<string, unknown>,
        sourceFile: metadata.source,
      };
    });

  const rawTargets =
    ((moduleDoc as Record<string, unknown> | undefined)?.targets as string[] | undefined) ?? [];
  if (moduleKind === "Library" && rawTargets.length > 0) {
    throw new Error(
      `Telo.Library at ${filePath} must not declare 'targets'. Targets are Application-only.`,
    );
  }

  const include = (moduleDoc as Record<string, unknown> | undefined)?.include as
    | string[]
    | undefined;

  const moduleMeta = moduleDoc as Record<string, unknown> | undefined;

  // `variables` / `secrets` are top-level doc fields (flat, not under
  // `metadata`) shared by both module variants: Applications bind them from the
  // host env, Libraries declare them as the importer contract.
  const variables = moduleMeta?.variables as Record<string, unknown> | undefined;
  const secrets = moduleMeta?.secrets as Record<string, unknown> | undefined;

  const base = {
    filePath,
    metadata: {
      name:
        (moduleDoc?.metadata.name as string | undefined) ??
        filePath
          .split("/")
          .pop()
          ?.replace(/\.ya?ml$/, "") ??
        "unknown",
      version: moduleDoc?.metadata.version as string | undefined,
      description: moduleDoc?.metadata.description as string | undefined,
      namespace: (moduleDoc?.metadata as Record<string, unknown>)?.namespace as string | undefined,
    },
    imports,
    resources,
    ...(include?.length ? { include } : {}),
    ...(variables ? { variables } : {}),
    ...(secrets ? { secrets } : {}),
  };

  if (moduleKind === "Library") {
    return { ...base, kind: "Library" };
  }
  // `ports` and `targets` are Application-only.
  return {
    ...base,
    kind: "Application",
    targets: rawTargets,
    ports: moduleMeta?.ports as Record<string, unknown> | undefined,
  };
}
