import { parseOciRef } from "@telorun/analyzer";
import * as fs from "fs/promises";
import * as path from "path";

/** Sits beside `.validated.json` inside `<cacheRoot>/manifests/`. */
export const ORIGINS_FILE = ".origins.json";
const ORIGINS_VERSION = 1;

interface OriginsRecord {
  version: number;
  /** `host/repo@tag` → the OCI manifest digest that produced the cached copy. */
  digests: Record<string, string>;
}

/** Identity under which a mutable ref's origin digest is recorded:
 *  `host/repo@tag`, independent of scheme spelling. */
export function originKey(ref: string): string {
  const { host, repo, reference } = parseOciRef(ref);
  return `${host}/${repo}@${reference}`;
}

/**
 * Read the recorded origin digests for one manifest cache directory.
 *
 * A missing, unreadable, or version-mismatched record yields an empty map: a
 * cached tag with no record is one nothing has verified, which every reader
 * treats as unknown — `telo check` re-fetches it, and a nested module's load
 * asks the registry for its parent's digest. It is a cache miss in the same
 * sense a failed `stat` is, not a suppressed error.
 */
export async function readOriginDigests(manifestsDir: string): Promise<Map<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(manifestsDir, ORIGINS_FILE), "utf-8");
  } catch {
    return new Map();
  }
  let parsed: OriginsRecord;
  try {
    parsed = JSON.parse(raw) as OriginsRecord;
  } catch {
    return new Map();
  }
  if (parsed?.version !== ORIGINS_VERSION || typeof parsed.digests !== "object") {
    return new Map();
  }
  return new Map(Object.entries(parsed.digests));
}

/** Persist origin digests, merging over whatever the record already held so a
 *  write for one entry never drops another's. */
export async function writeOriginDigests(
  manifestsDir: string,
  digests: Map<string, string>,
): Promise<void> {
  if (digests.size === 0) return;
  const merged = new Map([...(await readOriginDigests(manifestsDir)), ...digests]);
  const record: OriginsRecord = {
    version: ORIGINS_VERSION,
    digests: Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestsDir, ORIGINS_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf-8",
  );
}
