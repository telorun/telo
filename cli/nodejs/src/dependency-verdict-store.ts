import { TELO_RUNNING_SURFACE, type DependencyVerdict, type DependencyVerdictStore } from "@telorun/analyzer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "./logger.js";
import type { ManifestInput } from "./manifest-input.js";
import { outErrLine } from "./output.js";

/** Verdicts live beside the manifest cache, under the cache root. */
export const DEPENDENCY_VERDICTS_DIR = "dependency-verdicts";

export interface VerdictStoreOptions {
  /** Whether a verdict may be written; reads are always served. */
  write: boolean;
}

/**
 * Library verdicts kept as JSON files under `<cache root>/dependency-verdicts/`,
 * one per verdict key. Like the manifest cache this is an optimization: an
 * unreadable entry is recomputed and a failed write warns once, never fails the
 * check.
 */
export function fileDependencyVerdictStore(
  cacheRoot: string,
  options: VerdictStoreOptions,
  log: Logger,
): DependencyVerdictStore {
  const dir = path.join(cacheRoot, DEPENDENCY_VERDICTS_DIR);
  let warned = false;
  const warn = (message: string) => {
    if (warned) return;
    warned = true;
    outErrLine(`${log.err.warn(`[dependency-verdicts] ${message}`)}\n`);
  };
  return {
    async get(key) {
      let text: string;
      try {
        text = await fs.readFile(path.join(dir, `${key}.json`), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        warn(`read failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
      try {
        const parsed = JSON.parse(text) as DependencyVerdict;
        if (typeof parsed?.module === "string" && Array.isArray(parsed.diagnostics)) return parsed;
      } catch {
        // Falls through: a damaged entry is recomputed and rewritten below.
      }
      warn(`ignored a damaged entry ${key}.json`);
      return undefined;
    },
    async set(key, verdict) {
      if (!options.write) return;
      try {
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${key}.json`);
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          await fs.writeFile(tmp, JSON.stringify(verdict));
          await fs.rename(tmp, file);
        } catch (err) {
          await fs.rm(tmp, { force: true });
          throw err;
        }
      } catch (err) {
        warn(`write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** The store for `input`'s cache root; none for an input with no root. A sealed
 *  root is read, never written: only a run of the application adds to it. A
 *  `+unreleased` analyzer is a dev build whose code a version does not identify,
 *  so it keeps no verdicts. */
export function verdictStoreFor(
  input: ManifestInput,
  cacheWrite: boolean,
  log: Logger,
  analyzerVersion: string = TELO_RUNNING_SURFACE,
): DependencyVerdictStore | undefined {
  if (!input.cacheRoot || analyzerVersion.includes("+unreleased")) return undefined;
  return fileDependencyVerdictStore(input.cacheRoot, { write: cacheWrite && !input.cacheSealed }, log);
}
