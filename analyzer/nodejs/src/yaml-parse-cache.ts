import type { ResourceManifest } from "@telorun/sdk";
import type { DocumentPosition } from "./position-metadata.js";

/**
 * What a YAML parse must restore for a load to run without parsing: each
 * document's JSON projection and its position table. The `yaml` documents and
 * the read-only AST are not part of it — only an editor or a file rewrite reads
 * those, and a restored parse produces them by parsing on first access.
 */
export interface CachedYamlParse {
  readonly manifests: ReadonlyArray<ResourceManifest | null>;
  readonly positions: readonly DocumentPosition[];
}

/**
 * A store of YAML parses: one entry per source file, valid only for the text it
 * was parsed from. The analyzer owns what is stored and when; the host owns
 * where and how, since the analyzer runs in a browser and touches no filesystem.
 *
 * `read` returns undefined on a miss, including when `source` was last written
 * with other text. A write for a source replaces its previous entry, so a store
 * holds at most one parse per file however often the file changes. A parse that
 * reported errors is never written, so a hit is always an error-free parse.
 */
export interface YamlParseCache {
  read(source: string, text: string): CachedYamlParse | undefined;
  write(source: string, text: string, parse: CachedYamlParse): void;
}

/** Changes whenever what a {@link CachedYamlParse} holds, or how the parse
 *  derives it, changes — so a host keys its entries on it and an entry written
 *  by other parse code is never served. */
export const YAML_PARSE_CACHE_FORMAT = 1;
