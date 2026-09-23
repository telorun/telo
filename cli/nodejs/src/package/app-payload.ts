import { makeTarGz, readTarGz, type BundleEntry } from "@telorun/kernel";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * What a packaged application carries, and how it is laid out.
 *
 * One gzipped tar with three parts: the index below, the application's own files
 * under `app/`, and the warmed cache tree under `cache/`. The tar is framed by
 * the kernel's own writer, whose header fields are pinned, so the same closure
 * produces the same bytes and the unpack directory of a rebuilt-but-unchanged
 * application is the one already on disk.
 */

/** The index, at the root of every payload. */
export const PAYLOAD_INDEX = "telo-app.json";
/** The application's own files. */
export const APP_PREFIX = "app";
/** The warmed `.telo` tree, which becomes the app's cache root. */
export const CACHE_PREFIX = "cache";

/**
 * None of these can contribute to the analysis key: the stamp IS what the key
 * names, so it cannot name itself, while a compiled validator and a parsed
 * manifest are pure functions of a schema or a text the key already covers.
 */
const KEY_EXCLUDED = [
  `${CACHE_PREFIX}/analysis/`,
  `${CACHE_PREFIX}/validators/`,
  `${CACHE_PREFIX}/yaml-parses/`,
];

/** A platform as the payload records it — concrete, because the index is read
 *  by whoever holds the binary. `PlatformLike` is the same axes as the warm
 *  target sees them, where an axis may genuinely be undetermined. */
export interface AppPlatform {
  readonly os: string;
  readonly arch: string;
  readonly libc?: string;
  readonly abi?: string;
}

export interface PlatformLike {
  readonly os?: string;
  readonly arch?: string;
  readonly libc?: string;
  readonly abi?: string;
}

export interface AppModuleRecord {
  /** The module's canonical source — an `oci://` ref for a published module, a
   *  payload-relative path for a local one. */
  readonly source: string;
  readonly name?: string;
  readonly version?: string;
  /** `local` for a module built into `app/`, `artifact` for one materialized
   *  from its layers. */
  readonly delivery: "local" | "artifact";
}

export interface AppIndex {
  readonly format: number;
  readonly app: { readonly name: string; readonly version?: string };
  /** The entry manifest, payload-relative (`app/telo.yaml`). */
  readonly entry: string;
  readonly platform: AppPlatform;
  /** The telo that packaged this, which is also the telo inside the carrier. */
  readonly telo: string;
  /**
   * What the analysis verdict in `cache/analysis/` is a verdict ABOUT: a digest
   * over every payload entry that can change it. The stamp is keyed and signed
   * by this instead of by the entry URL and the absolute source paths of the
   * files it covers, neither of which survives being unpacked somewhere else —
   * so without it a packaged app re-runs the whole validation walk at every
   * start, silently, because a stamp miss is the designed quiet recovery.
   */
  readonly analysisKey: string;
  readonly modules: readonly AppModuleRecord[];
}

/** The key the analysis stamp is filed and signed under: a digest over the file
 *  set the verdict covers, payload-relative so it is the same wherever the
 *  payload is unpacked. */
export function analysisKeyFor(entries: readonly BundleEntry[]): string {
  const hash = createHash("sha256");
  const covered = entries
    .filter((entry) => !KEY_EXCLUDED.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => [entry.name, entryDigest(entry)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, digest] of covered) hash.update(`${name}\0${digest}\n`);
  return hash.digest("hex");
}

function entryDigest(entry: BundleEntry): string {
  if ("link" in entry) return `link:${entry.link}`;
  return createHash("sha256")
    .update(typeof entry.content === "string" ? Buffer.from(entry.content) : entry.content)
    .digest("hex");
}

export async function packPayload(entries: readonly BundleEntry[]): Promise<Buffer> {
  return makeTarGz([...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

export async function readPayloadIndex(payload: Buffer): Promise<AppIndex> {
  for (const entry of await readTarGz(payload)) {
    if (entry.name !== PAYLOAD_INDEX || "link" in entry) continue;
    return JSON.parse(Buffer.from(entry.content).toString("utf8")) as AppIndex;
  }
  throw new Error(`the payload carries no ${PAYLOAD_INDEX}`);
}

/**
 * Write a payload's files under `dir`.
 *
 * Every entry is confined to `dir`: a payload is data, and one naming `../`
 * would write outside the directory the runtime believes it owns. Directories
 * are created `0700` like the root, since they hold the application's source.
 */
export async function unpackPayload(payload: Buffer, dir: string): Promise<void> {
  const root = path.resolve(dir);
  for (const entry of await readTarGz(payload)) {
    const target = path.resolve(root, entry.name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`the payload names '${entry.name}', which resolves outside the app directory`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if ("link" in entry) {
      // A link is payload content like any other file — `sources:` entries
      // create them — so where it POINTS is confined the same way the entry's
      // own path is. Without this, `app/x -> /etc` followed by `app/x/passwd`
      // writes outside the tree, and the trailer digest is no defence: whoever
      // rewrites the payload rewrites the trailer with it.
      const resolved = path.resolve(path.dirname(target), entry.link);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(
          `the payload links '${entry.name}' to '${entry.link}', which leads outside the app directory`,
        );
      }
      await fsp.symlink(entry.link, target);
      continue;
    }
    await fsp.writeFile(target, entry.content, { mode: entry.executable ? 0o700 : 0o600 });
  }
}

/** One on-disk file as a payload entry, preserving the executable bit a staged
 *  native file or a downloaded tool carries. */
export function fileEntry(name: string, file: string): BundleEntry {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { name, link: fs.readlinkSync(file) };
  const content = fs.readFileSync(file);
  return (stat.mode & 0o111) !== 0 ? { name, content, executable: true } : { name, content };
}

/** Every file under `dir`, as payload entries prefixed with `prefix`. Used for
 *  the warmed cache tree, which the packager built itself and therefore ships
 *  whole. */
export function directoryEntries(dir: string, prefix: string): BundleEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: BundleEntry[] = [];
  for (const found of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const abs = path.join(found.parentPath, found.name);
    if (!found.isFile() && !found.isSymbolicLink()) continue;
    const rel = path.relative(dir, abs).split(path.sep).join("/");
    entries.push(fileEntry(`${prefix}/${rel}`, abs));
  }
  return entries;
}
