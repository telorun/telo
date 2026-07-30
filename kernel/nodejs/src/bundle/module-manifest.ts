import { parseLayerIndex, type ArtifactLayer } from "@telorun/analyzer";
import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments, type Document } from "yaml";

const OWNER_KINDS = new Set(["Telo.Application", "Telo.Library"]);

/** Parse a manifest's YAML documents, tolerating its `!cel` / `!ref` tags. */
export function parseManifestDocs(text: string): Document[] {
  return parseAllDocuments(text, { customTags: defaultCustomTags() });
}

/** The owner document of a manifest — the single `Telo.Application` /
 *  `Telo.Library` doc that carries its identity, `files:` / `assets:`, and the
 *  published `layers:` index. The one place that selects it, shared by every
 *  reader/writer. */
export function findOwnerDoc(docs: Document[]): Document | undefined {
  return docs.find((d) => {
    const kind = (d.toJSON() as { kind?: string } | null)?.kind;
    return kind !== undefined && OWNER_KINDS.has(kind);
  });
}

/** The owner-doc fields the transports read: identity for the publish location,
 *  and payload markers for artifact fetch. */
export interface OwnerManifest {
  name?: string;
  version?: string;
  /** The published layer index, absent on an unpublished manifest. Parsed and
   *  validated through the analyzer's shared model, so a malformed index is a
   *  hard `LayerIndexError` rather than a silently ignored field. */
  layers?: ArtifactLayer[];
  /** Ordered `.gitignore`-style patterns the author claimed as the lazily
   *  materialized `assets` layer. */
  assetPatterns: string[];
  /** True when the owner doc declares a non-empty `files:` list. */
  declaresFiles: boolean;
  /** Descriptive provenance a transport projects into its backend's metadata
   *  (OCI annotations). Never used to address the artifact. */
  description?: string;
  repository?: string;
  license?: string;
  documentation?: string;
}

/** Read the owner doc's identity + payload fields from a manifest, parsing once
 *  (never regex-scraping). The single source both transports call for the
 *  module's name and version, its layer index, and payload detection. */
export function readOwnerManifest(text: string): OwnerManifest {
  const owner = findOwnerDoc(parseManifestDocs(text));
  const parsed = owner?.toJSON() as
    | {
        metadata?: Record<string, unknown>;
        files?: unknown;
        assets?: unknown;
        layers?: unknown;
      }
    | undefined;
  const md = parsed?.metadata ?? {};
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const patterns = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
  return {
    name: str(md.name),
    version: str(md.version),
    layers: parsed?.layers === undefined ? undefined : parseLayerIndex(parsed.layers),
    assetPatterns: patterns(parsed?.assets),
    declaresFiles: Array.isArray(parsed?.files) && parsed.files.length > 0,
    description: str(md.description),
    repository: str(md.repository),
    license: str(md.license),
    documentation: str(md.documentation),
  };
}
