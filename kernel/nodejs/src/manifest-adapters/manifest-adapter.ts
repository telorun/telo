export interface ManifestSourceData {
  /** Raw YAML text */
  text: string;
  /** Parsed YAML documents (result of yaml.loadAll) */
  documents: any[];
  /** Stored as metadata.source (file path or URL) */
  source: string;
  /** Base directory for resolving relative controller entrypoints */
  baseDir: string;
  /** URI prefix — full resource URI is `${uriBase}#${kind}.${name}` */
  uriBase: string;
}

export interface ManifestAdapter {
  /** Returns true if this adapter can handle the given path/URL */
  supports(pathOrUrl: string): boolean;
  /**
   * Read a single manifest entry point.
   * - File path or URL → read that file/URL.
   * - Directory path → find and read `module.yaml` within it.
   */
  read(pathOrUrl: string): Promise<ManifestSourceData>;
  /**
   * Read all manifest files reachable from the given path/URL.
   * Used for module imports.
   * - Directory path → recursive walk, one entry per .yaml/.yml file found.
   * - File path or URL → single-item array.
   */
  readAll(pathOrUrl: string): Promise<ManifestSourceData[]>;
  /**
   * Resolve a potentially relative path/URL against a base directory/URL.
   * For absolute inputs the base is ignored.
   */
  resolveRelative(base: string, relative: string): string;
}
