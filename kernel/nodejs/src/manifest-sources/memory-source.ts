import { DEFAULT_MANIFEST_FILENAME, type ManifestSource } from "@telorun/analyzer";
import { posix } from "node:path";
import { stringify as yamlStringify } from "yaml";

const SCHEME = "memory://";

function stripScheme(url: string): string {
  return url.startsWith(SCHEME) ? url.slice(SCHEME.length) : url;
}

function isAbsoluteUrl(s: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(s);
}

/** In-memory `ManifestSource` for embedders and tests. Register manifest text
 *  (or parsed-manifest object arrays) under bare module names; the source
 *  canonicalizes module entry points as `<name>/telo.yaml`, mirroring disk's
 *  "module is a directory containing telo.yaml" convention so relative imports
 *  (`./sub`, `../sibling`) work transparently with POSIX path resolution. */
export class MemorySource implements ManifestSource {
  private readonly entries = new Map<string, string>();

  /** Register a manifest source. `name` is a bare module name (`"app"`,
   *  `"lib"`, or hierarchical `"auth/login"`) or a partial-file path with a
   *  `.yaml`/`.yml` extension. Bare names are stored under `<name>/telo.yaml`;
   *  extension-bearing names are stored literally. Object-array `content` is
   *  serialized via `yaml.stringify` so the loader downstream is identical to
   *  the YAML-text path. */
  set(name: string, content: string | unknown[]): void {
    if (!name) {
      throw new Error("MemorySource.set: name must be non-empty");
    }
    if (name.startsWith("/")) {
      throw new Error(
        `MemorySource.set: name '${name}' must not start with '/' — memory:// has no absolute root`,
      );
    }
    if (isAbsoluteUrl(name)) {
      throw new Error(
        `MemorySource.set: name '${name}' must be a bare key, not a URL with a scheme`,
      );
    }
    const normalized = posix.normalize(name);
    if (normalized.startsWith("..") || normalized === "." || normalized === "..") {
      throw new Error(
        `MemorySource.set: name '${name}' contains '..' segments that escape the namespace`,
      );
    }

    const text = typeof content === "string"
      ? content
      : content
          .filter((doc) => doc !== null && doc !== undefined)
          .map((doc) => yamlStringify(doc))
          .join("---\n");

    const hasYamlExt = normalized.endsWith(".yaml") || normalized.endsWith(".yml");
    const key = hasYamlExt ? normalized : `${normalized}/${DEFAULT_MANIFEST_FILENAME}`;
    this.entries.set(key, text);
  }

  supports(url: string): boolean {
    return url.startsWith(SCHEME);
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const key = stripScheme(url);
    // Direct hit (literal-extension files, or already-canonicalized telo.yaml URLs).
    const direct = this.entries.get(key);
    if (direct !== undefined) {
      return { text: direct, source: `${SCHEME}${key}` };
    }
    // Directory-style fall-through: bare module name → <name>/telo.yaml.
    const fallback = `${key}/${DEFAULT_MANIFEST_FILENAME}`;
    const fallbackText = this.entries.get(fallback);
    if (fallbackText !== undefined) {
      return { text: fallbackText, source: `${SCHEME}${fallback}` };
    }
    throw new Error(
      `MemorySource: no entry for '${url}'. Tried keys '${key}' and '${fallback}'.`,
    );
  }

  resolveRelative(base: string, relative: string): string {
    if (isAbsoluteUrl(relative)) {
      throw new Error(
        `MemorySource.resolveRelative: relative '${relative}' is an absolute URL — pass it directly, not through resolveRelative`,
      );
    }
    if (relative.startsWith("/")) {
      throw new Error(
        `MemorySource.resolveRelative: 'memory://' has no absolute root; use a full 'memory://<name>' URL instead of '${relative}'`,
      );
    }
    const baseKey = stripScheme(base);
    const joined = posix.normalize(posix.join(posix.dirname(baseKey), relative));
    if (joined === ".." || joined.startsWith("../")) {
      throw new Error(
        `MemorySource.resolveRelative: relative '${relative}' escapes the memory:// namespace from base '${base}'`,
      );
    }
    return `${SCHEME}${joined}`;
  }
}
