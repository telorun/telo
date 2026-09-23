import {
  YAML_PARSE_CACHE_FORMAT,
  type CachedYamlParse,
  type YamlParseCache,
} from "@telorun/analyzer";
import type { Logger } from "@telorun/sdk";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import * as path from "path";
import { deserialize, serialize } from "v8";
import { readVersion, reportUndeterminableVersion } from "../runtime-versions.js";

/**
 * YAML parses on disk, under `<cache-root>/yaml-parses/`, one file per source.
 *
 * Parsing is most of a warm load: a module's `telo.yaml` is a large
 * multi-document file and the `yaml` library composes it at around 1 MB/s, while
 * restoring the same result is a structured-clone read. The entry is the
 * analyzer's {@link CachedYamlParse}; what it holds is the analyzer's decision.
 *
 * A file is named by the source URL and the runtime family — the `v8`
 * serialization format is the runtime's own, and Bun's and Node's are not each
 * other's — so an edited file or an upgraded version overwrites its own entry
 * rather than adding one, and the directory holds at most one entry per source
 * per runtime family. Inside, the entry records its key: the text's hash plus
 * everything that decides what parsing it produces — the analyzer's cache
 * format, the analyzer, templating (the custom tags) and `yaml` versions, and
 * the exact runtime. A read whose key differs is a miss. A version that cannot
 * be determined disables the cache rather than keying on a placeholder.
 *
 * An absent or stale entry is a miss. An entry that is present and cannot be
 * read is a failure of the cache itself, reported once, and read as a miss.
 */
export function createParsedYamlCache(
  directory: string,
  options: { write: boolean; log: Logger },
): YamlParseCache | undefined {
  const versions = {
    analyzer: readVersion("@telorun/analyzer"),
    templating: readVersion("@telorun/templating"),
    yaml: readVersion("yaml"),
  };
  const unknown = Object.entries(versions)
    .filter(([, version]) => version === undefined)
    .map(([name]) => (name === "yaml" ? name : `@telorun/${name}`));
  if (unknown.length > 0) {
    reportUndeterminableVersion("parsed YAML", unknown, (message) => options.log.error(message));
    return undefined;
  }
  const runtimeFamily = process.versions.bun ? "bun" : "node";
  const keyPrefix = JSON.stringify({
    format: YAML_PARSE_CACHE_FORMAT,
    runtime: process.versions.bun ? `bun@${process.versions.bun}` : `node@${process.version}`,
    ...versions,
  });
  const entryPath = (source: string) =>
    path.join(
      directory,
      `${createHash("sha256").update(runtimeFamily).update("\0").update(source).digest("hex")}.bin`,
    );
  const keyOf = (text: string) =>
    createHash("sha256").update(keyPrefix).update("\0").update(text).digest("hex");

  let readFailureReported = false;
  let writable = options.write;
  let directoryMade = false;

  return {
    read(source, text) {
      const file = entryPath(source);
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        reportRead(file, error);
        return undefined;
      }
      try {
        const entry = deserialize(bytes) as StoredParse;
        if (!isStoredParse(entry)) {
          reportRead(file, new Error("the entry does not hold a parse"));
          return undefined;
        }
        if (entry.key !== keyOf(text)) return undefined;
        return { manifests: entry.manifests, positions: entry.positions };
      } catch (error) {
        reportRead(file, error);
      }
      return undefined;
    },
    write(source, text, parse) {
      if (!writable) return;
      const file = entryPath(source);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        if (!directoryMade) {
          mkdirSync(directory, { recursive: true });
          directoryMade = true;
        }
        const entry: StoredParse = {
          key: keyOf(text),
          manifests: parse.manifests,
          positions: parse.positions,
        };
        writeFileSync(tmp, serialize(entry));
        renameSync(tmp, file);
      } catch (error) {
        // One report, then no more writes: the condition is the directory's,
        // and every later write would fail the same way.
        writable = false;
        options.log.warn(
          `telo: the parsed YAML cache at ${directory} cannot be written; manifests will be parsed on every load: ${messageOf(error)}`,
        );
      }
    },
  };

  function reportRead(file: string, error: unknown): void {
    if (readFailureReported) return;
    readFailureReported = true;
    options.log.warn(
      `telo: a parsed YAML cache entry could not be read (${file}); the manifest is parsed instead: ${messageOf(error)}`,
    );
  }
}

interface StoredParse extends CachedYamlParse {
  readonly key: string;
}

function isStoredParse(value: unknown): value is StoredParse {
  if (!value || typeof value !== "object") return false;
  const { key, manifests, positions } = value as Partial<StoredParse>;
  return (
    typeof key === "string" &&
    Array.isArray(manifests) &&
    Array.isArray(positions) &&
    manifests.length === positions.length &&
    positions.every((p) => p && typeof p.sourceLine === "number" && p.positionIndex instanceof Map)
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
