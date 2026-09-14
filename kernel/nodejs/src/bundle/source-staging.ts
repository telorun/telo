/**
 * Fetching, extracting and writing the files a module's `sources:` block stages.
 *
 * One implementation for both callers: `telo release stage` stages every entry
 * of a module, and a kernel reading a source checkout stages the one entry a
 * resolution needs, on first use — the way it builds a controller from source.
 * Either way a file is written only once its bytes and execute bit match the
 * pin, so what lands on disk is what the manifest says it is.
 */

import {
  resolveSourceUrl,
  sourceUrlProblem,
  type ModuleSource,
  type SourceArchiveFormat,
  type SourceEntry,
} from "@telorun/analyzer";
import { NOOP_LOGGER, type Logger } from "@telorun/sdk";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withDirectoryLock } from "../directory-lock.js";
import { assertPublicEgress } from "../transports/egress-guard.js";
import { checkStagedEntry, type StagedEntryState } from "./staged-entry.js";
import { readTarGz, type BundleEntry } from "./tar.js";

/** Reads the archive at a URL, in the format its source declares, into its entries. */
export type ArchiveReader = (url: string, format: SourceArchiveFormat) => Promise<BundleEntry[]>;

/** The archive could not be obtained: the network, the upstream, or the egress
 *  policy refused it. Distinct from an archive that was obtained and does not
 *  hold what the pin says, which is never a question of the environment. */
export class ArchiveFetchError extends Error {}

/** The archive was obtained and does not hold the file its entry declares: the
 *  member is absent or ambiguous, the archive does not read, or the bytes or
 *  execute bit differ from the pin. Any other staging failure — a lock that
 *  could not be taken, a write that failed — is neither this nor a fetch error. */
export class ArchiveContentError extends Error {}

/** A staging failure as the clause after "the file is staged by source 'x'",
 *  saying which kind it was, so a lock or a write is never read as a bad pin. */
export function describeStagingFailure(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof ArchiveFetchError) return `and its archive could not be fetched: ${detail}`;
  if (err instanceof ArchiveContentError) return `but its archive does not hold the pinned file: ${detail}`;
  return `and staging it failed: ${detail}`;
}

const FETCH_TIMEOUT_MS = 5 * 60_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 10;

function fetchFailure(url: string, err: unknown, timeoutMs: number): ArchiveFetchError {
  if ((err as { name?: unknown }).name === "TimeoutError") {
    return new ArchiveFetchError(
      `could not fetch the archive ${url}: no complete response within ${timeoutMs / 1000}s`,
    );
  }
  const cause = (err as { cause?: unknown }).cause;
  const detail = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
  return new ArchiveFetchError(`could not fetch the archive ${url}: ${detail}`);
}

/**
 * One fetch per URL for the life of the reader; the caller decides that life. A
 * request is bounded in time, in response size and in decompressed size, may not
 * end at a URL a source could not name, and follows the kernel's egress policy
 * (`TELO_EGRESS`) at every hop.
 */
export function createArchiveReader(
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
    maxExtractedBytes?: number;
  } = {},
): ArchiveReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const maxExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
  const cache = new Map<string, Promise<BundleEntry[]>>();
  return (url, format) => {
    const key = `${format}\0${url}`;
    let entries = cache.get(key);
    if (!entries) {
      entries = (async () => {
        const bytes = await fetchArchive(url, fetchImpl, timeoutMs, maxBytes);
        try {
          return await readTarGz(bytes, { maxBytes: maxExtractedBytes });
        } catch (err) {
          throw new ArchiveContentError(
            `the archive ${url} does not read as ${format}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      cache.set(key, entries);
    }
    return entries;
  };
}

async function fetchArchive(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<Buffer> {
  const tooLarge = () => new ArchiveFetchError(`the archive ${url} is larger than the ${maxBytes}-byte limit`);
  const signal = AbortSignal.timeout(timeoutMs);
  // Redirects are followed here rather than by fetch, so each location is vetted
  // before any request goes to it: a redirect may not take the request somewhere
  // the manifest could not have named — a plain-http location above all.
  let response: Response;
  let current = url;
  for (let hops = 0; ; hops++) {
    try {
      await assertPublicEgress(current);
    } catch (err) {
      throw new ArchiveFetchError(
        `the archive request ${current} was refused: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      response = await fetchImpl(current, { signal, redirect: "manual" });
    } catch (err) {
      throw fetchFailure(url, err, timeoutMs);
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) break;
    await response.body?.cancel();
    if (hops === MAX_REDIRECTS) {
      throw new ArchiveFetchError(`the archive request ${url} was redirected more than ${MAX_REDIRECTS} times`);
    }
    const next = new URL(location, current).href;
    const refusal = sourceUrlProblem(next);
    if (refusal) {
      throw new ArchiveFetchError(`the archive request ${url} was redirected to ${next}: ${refusal.detail}`);
    }
    current = next;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ArchiveFetchError(`the archive request ${url} answered ${response.status} ${response.statusText}`);
  }
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ArchiveFetchError(`the archive request ${url} answered with no body`);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw fetchFailure(url, err, timeoutMs);
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks);
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const memberName = (name: string): string => name.replace(/^(\.\/)+/, "");

/** One file out of the archive a source names. */
export async function extractMember(
  archives: ArchiveReader,
  source: ModuleSource,
  url: string,
  member: string,
): Promise<{ content: Buffer; executable: boolean }> {
  const entries = await archives(url, source.archive);
  const matches = entries.filter((entry) => memberName(entry.name) === memberName(member));
  if (matches.length > 1) {
    throw new ArchiveContentError(
      `member '${member}' occurs ${matches.length} times in the archive, so which file it names is ambiguous`,
    );
  }
  const found = matches[0];
  if (!found) throw new ArchiveContentError(`member '${member}' is not in the archive`);
  if ("link" in found) {
    throw new ArchiveContentError(`member '${member}' is a symbolic link in the archive, not a file`);
  }
  const content = typeof found.content === "string" ? Buffer.from(found.content) : Buffer.from(found.content);
  return { content, executable: found.executable === true };
}

/**
 * Refuse an entry whose parent path crosses a symbolic link or a non-directory
 * on disk: the path is confined as text, but a checked-out link would carry
 * every rm, mkdir, write and symlink below it outside the module.
 */
function assertConfined(dir: string, entryPath: string): void {
  const segments = entryPath.split("/").slice(0, -1);
  let current = dir;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `'${path.relative(dir, current)}' is a symbolic link on disk; staging below it would write outside the module. Replace it with a directory.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`'${path.relative(dir, current)}' exists on disk and is not a directory.`);
    }
  }
}

/** Replace `abs` in one step, so a concurrent reader sees the old file or the new
 *  one and never a partial write; a link left at the path is replaced, not
 *  written through. */
function replaceEntry(abs: string, write: (temp: string) => void): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    write(temp);
    fs.renameSync(temp, abs);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Fetch one file entry from its source's archive and write it, once its bytes
 * and execute bit match the pin. Throws naming what did not match; an archive
 * that could not be obtained throws {@link ArchiveFetchError}.
 */
async function stageFileEntry(
  dir: string,
  source: ModuleSource,
  entry: Extract<SourceEntry, { kind: "file" }>,
  archives: ArchiveReader,
): Promise<void> {
  if (!entry.pin) {
    throw new Error("the entry is not pinned — run `telo release stage --pin` to write its sha256 and executable");
  }
  assertConfined(dir, entry.path);
  const url = resolveSourceUrl(source, entry.upstream);
  const { content, executable } = await extractMember(archives, source, url, entry.member);
  const digest = sha256Hex(content);
  if (digest !== entry.pin.sha256) {
    throw new ArchiveContentError(
      `member '${entry.member}' hashes to sha256 ${digest}, but the pin is ${entry.pin.sha256}`,
    );
  }
  if (executable !== entry.pin.executable) {
    throw new ArchiveContentError(
      `member '${entry.member}' is ${executable ? "" : "not "}executable, but the pin says executable: ${entry.pin.executable}`,
    );
  }
  replaceEntry(path.join(dir, entry.path), (temp) => {
    fs.writeFileSync(temp, content);
    fs.chmodSync(temp, executable ? 0o755 : 0o644);
  });
}

/** Create one link entry, unless it is already stored as declared. */
function stageLinkEntry(dir: string, entry: Extract<SourceEntry, { kind: "link" }>): void {
  assertConfined(dir, entry.path);
  const abs = path.join(dir, entry.path);
  const existing = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() && fs.readlinkSync(abs) === entry.target) return;
  replaceEntry(abs, (temp) => fs.symlinkSync(entry.target, temp));
}

/** What a staged entry is once {@link ensureStagedEntry} returns: staging leaves
 *  nothing short of a match, and an unpinned entry is never staged. */
export type EnsuredEntryState = Extract<StagedEntryState, { state: "match" | "unpinned" }>;

export interface StagingOptions {
  /** One reader per resolution, so entries from one archive fetch it once. */
  readonly archives?: ArchiveReader;
  /** Receives one line when a fetch starts — a first run can wait minutes. */
  readonly log?: Logger;
}

/**
 * Bring one staged entry to its pin, staging it when it is missing or no longer
 * matches — following a link through its source to the file it leads to, and
 * creating the links on the way.
 *
 * An unpinned entry is returned as it is, never staged: nothing could verify what
 * a fetch returned. Concurrent callers, in this process or another, serialize per
 * archive URL, and each re-checks before fetching, so an archive is fetched once
 * while entries from different archives stage side by side.
 */
export async function ensureStagedEntry(
  dir: string,
  source: ModuleSource,
  entry: SourceEntry,
  options: StagingOptions = {},
): Promise<EnsuredEntryState> {
  const before = await checkStagedEntry(dir, source, entry);
  if (before.state === "match" || before.state === "unpinned") return before;

  const links: Extract<SourceEntry, { kind: "link" }>[] = [];
  let current: SourceEntry | undefined = entry;
  while (current?.kind === "link") {
    const link: Extract<SourceEntry, { kind: "link" }> = current;
    if (links.some((seen) => seen.path === link.path)) {
      throw new Error(`the link '${entry.path}' of source '${source.name}' leads back to '${link.path}'`);
    }
    links.push(link);
    current = source.entries.find((candidate) => candidate.path === link.resolved);
    if (!current) {
      throw new Error(`the link '${link.path}' of source '${source.name}' leads to no entry of that source`);
    }
  }
  const file = current;
  if (!file.pin) return { state: "unpinned" };
  const url = resolveSourceUrl(source, file.upstream);
  const archives = options.archives ?? createArchiveReader();
  const log = options.log ?? NOOP_LOGGER;

  // Under the module's own `.telo/`, which every checkout ignores, so a lock left
  // by a killed process never shows up as a change to the module.
  const lock = path.join(dir, ".telo", "staging", createHash("sha256").update(url).digest("hex").slice(0, 16));
  await withDirectoryLock(
    lock,
    "staged file",
    async () => {
      if ((await checkStagedEntry(dir, source, file)).state !== "match") {
        log.info(`staging '${file.path}' of the module at ${dir} from ${url}`, {
          "telo.staging.module": dir,
          "telo.staging.entry": file.path,
          "telo.staging.url": url,
        });
        await stageFileEntry(dir, source, file, archives);
      }
      for (const link of links.reverse()) stageLinkEntry(dir, link);
    },
    log,
  );
  return { state: "match" };
}
