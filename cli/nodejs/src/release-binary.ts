import { readTarGz } from "@telorun/kernel";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readZipEntry, zipEntryNames } from "./package/zip.js";

/**
 * The released `telo` binary of one version for one platform: downloaded from
 * that release, verified against the release's own `checksums.txt`, and kept in
 * the user cache.
 *
 * Two commands need exactly this and nothing more of each other — `telo package`
 * (the carrier an application is packaged into) and `telo runner` (the telo an
 * application asked to run on, when it is not this one) — so the fetch lives
 * here and each says, in its own words, what a failure means for it.
 *
 * **Verified or refused.** A release that publishes no checksum for its binary
 * is a condition to stop at: continuing would run, or ship, a network-fetched
 * executable on the strength of nothing.
 */

const RELEASE_REPO = process.env.TELO_REPO?.trim() || "telorun/telo";

/**
 * Every platform a `telo` binary is published for, in Telo's own vocabulary,
 * with the ARCHIVE the release publishes it in.
 *
 * The format is part of the target rather than derived at the download, because
 * it is not one fact but two and they differ per platform: a Windows asset is a
 * `.zip` holding `telo.exe` at its root (built with `Compress-Archive`, which is
 * what `Expand-Archive` on a bare Windows machine can open), and every other is
 * a `.tar.gz` whose binary sits inside a `telo-<version>-<target>/` directory,
 * so an extract cannot scatter a bare `telo` into the current directory.
 *
 * `linux/arm64/musl` is absent because nodejs.org publishes no runtime to
 * inject into, so no binary exists — said here rather than discovered as a
 * 404 at the download.
 */
export const RELEASE_BINARY_TARGETS: Record<string, { exe: string; archive: "tar.gz" | "zip" }> = {
  "linux-amd64-gnu": { exe: "", archive: "tar.gz" },
  "linux-amd64-musl": { exe: "", archive: "tar.gz" },
  "linux-arm64-gnu": { exe: "", archive: "tar.gz" },
  "darwin-amd64": { exe: "", archive: "tar.gz" },
  "darwin-arm64": { exe: "", archive: "tar.gz" },
  "windows-amd64": { exe: ".exe", archive: "zip" },
  "windows-arm64": { exe: ".exe", archive: "zip" },
};

/** Node's platform and architecture names in Telo's own vocabulary. Only the
 *  tuples a binary exists for are named. */
const OS_TOKENS: Record<string, string | undefined> = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows",
};
const ARCH_TOKENS: Record<string, string | undefined> = { x64: "amd64", arm64: "arm64" };

/** This machine in the release-asset spelling (`linux-amd64-gnu`), or `null`
 *  for an OS or architecture no asset is named after. */
export function hostReleaseTarget(): string | null {
  const os = OS_TOKENS[process.platform];
  const arch = ARCH_TOKENS[process.arch];
  if (!os || !arch) return null;
  if (os !== "linux") return `${os}-${arch}`;
  return `${os}-${arch}-${isMuslHost() ? "musl" : "gnu"}`;
}

/** Read from the interpreter this Node was linked against rather than from a
 *  distro name. */
function isMuslHost(): boolean {
  try {
    return execFileSync("ldd", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .toLowerCase()
      .includes("musl");
  } catch (err) {
    return /musl/i.test(String((err as { stderr?: unknown })?.stderr ?? ""));
  }
}

/** Why a release binary could not be had. The message stands on its own; the
 *  `cause` lets a caller add what the failure means for ITS purpose. */
export type ReleaseBinaryFailure =
  | "unpublished-platform"
  | "not-published"
  | "unreachable"
  | "checksums-missing"
  | "checksum-unlisted"
  | "checksum-mismatch"
  | "archive-malformed"
  | "no-cache-directory"
  | "cache-corrupt";

export class ReleaseBinaryError extends Error {
  constructor(
    public readonly failure: ReleaseBinaryFailure,
    message: string,
  ) {
    super(message);
    this.name = "ReleaseBinaryError";
  }
}

export interface ReleaseBinaryOptions {
  /** `<cache root>/<version>/telo-<target>` is where the binary is kept; `null`
   *  when this process has nowhere writable. */
  cacheRoot: string | null;
  report?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
}

/**
 * The path of telo `version`'s binary for `target`, fetching it on first use.
 *
 * A cached binary is rechecked against the digest recorded when it was written
 * before its path is handed out: what is about to be executed is the bytes that
 * were verified, not whatever is at that path now.
 */
export function releaseBinary(
  target: string,
  version: string,
  options: ReleaseBinaryOptions,
): Promise<string> {
  // One fetch per binary at a time. Two applications started together on a
  // version this machine does not hold would otherwise each download it, and
  // the first to finish would hand out a path the second is still replacing.
  const key = `${options.cacheRoot ?? ""}\u0000${version}\u0000${target}`;
  const running = inFlight.get(key);
  if (running) return running;
  const fetched = fetchReleaseBinary(target, version, options).finally(() => inFlight.delete(key));
  inFlight.set(key, fetched);
  return fetched;
}

const inFlight = new Map<string, Promise<string>>();

async function fetchReleaseBinary(
  target: string,
  version: string,
  options: ReleaseBinaryOptions,
): Promise<string> {
  const spec = RELEASE_BINARY_TARGETS[target];
  if (!spec) {
    throw new ReleaseBinaryError(
      "unpublished-platform",
      `no telo binary is published for ${target}. ` +
        `Published platforms: ${Object.keys(RELEASE_BINARY_TARGETS).join(", ")}.`,
    );
  }
  const cached = options.cacheRoot
    ? path.join(options.cacheRoot, version, `telo-${target}${spec.exe}`)
    : undefined;
  if (cached) {
    const recorded = await readRecordedDigest(cached);
    if (recorded !== undefined && fs.existsSync(cached)) {
      const actual = await sha256OfFile(cached);
      if (actual === recorded) return cached;
      throw new ReleaseBinaryError(
        "cache-corrupt",
        `the cached telo ${version} binary at ${cached} is not the file that was downloaded ` +
          `(sha256 ${actual}, recorded ${recorded}). Delete it to fetch the release again.`,
      );
    }
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const asset = `telo-${version}-${target}.${spec.archive}`;
  const base = `https://github.com/${RELEASE_REPO}/releases/download/v${version}`;
  options.report?.(`fetching ${base}/${asset}`);
  const response = await request(fetchImpl, `${base}/${asset}`);
  if (response.status === 404) {
    throw new ReleaseBinaryError(
      "not-published",
      `telo ${version} publishes no binary for ${target} (HTTP 404 at ${base}/${asset}): ` +
        `either there is no release ${version}, or it carries no binary for this platform.`,
    );
  }
  if (!response.ok) {
    throw new ReleaseBinaryError(
      "unreachable",
      `downloading telo ${version} for ${target} failed (HTTP ${response.status} at ${base}/${asset}).`,
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  await verifyChecksum(fetchImpl, base, asset, archive);

  const binary = await binaryFromArchive(archive, asset, target, version);
  if (!cached) {
    throw new ReleaseBinaryError(
      "no-cache-directory",
      `there is no writable cache directory to keep the downloaded telo ${version} in. ` +
        `Set TELO_APP_DIR to a writable path.`,
    );
  }
  // Written under a name no other write shares and moved into place, so nothing
  // — another process fetching the same binary included — ever reads half of it.
  await fsp.mkdir(path.dirname(cached), { recursive: true });
  const partial = `${cached}.${randomUUID()}.partial`;
  await fsp.writeFile(partial, binary, { mode: 0o755 });
  await fsp.rename(partial, cached);
  await fsp.writeFile(digestFile(cached), createHash("sha256").update(binary).digest("hex"));
  return cached;
}

function digestFile(binary: string): string {
  return `${binary}.sha256`;
}

async function readRecordedDigest(binary: string): Promise<string | undefined> {
  try {
    const text = (await fsp.readFile(digestFile(binary), "utf8")).trim();
    return /^[0-9a-f]{64}$/.test(text) ? text : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function request(fetchImpl: typeof globalThis.fetch, url: string): Promise<Response> {
  try {
    return await fetchImpl(url);
  } catch (err) {
    const cause = (err as { cause?: unknown })?.cause;
    const detail = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
    throw new ReleaseBinaryError("unreachable", `could not reach ${url}: ${detail}.`);
  }
}

/** The binary inside a release asset, at the path that asset's own format puts
 *  it — the two differ, and the archive says which one it is. */
async function binaryFromArchive(
  archive: Buffer,
  asset: string,
  target: string,
  version: string,
): Promise<Buffer> {
  const spec = RELEASE_BINARY_TARGETS[target]!;
  if (spec.archive === "zip") {
    const wanted = `telo${spec.exe}`;
    const entry = readZipEntry(archive, wanted);
    if (!entry) {
      throw new ReleaseBinaryError(
        "archive-malformed",
        `${asset} does not contain ${wanted} (it holds ${zipEntryNames(archive).join(", ")})`,
      );
    }
    return entry.contents;
  }
  const wanted = `telo-${version}-${target}/telo${spec.exe}`;
  for (const entry of await readTarGz(archive)) {
    if (entry.name !== wanted || "link" in entry) continue;
    return Buffer.from(entry.content);
  }
  throw new ReleaseBinaryError("archive-malformed", `${asset} does not contain ${wanted}`);
}

/** The release publishes one `checksums.txt` covering every asset. */
async function verifyChecksum(
  fetchImpl: typeof globalThis.fetch,
  base: string,
  asset: string,
  bytes: Buffer,
): Promise<void> {
  const response = await request(fetchImpl, `${base}/checksums.txt`);
  if (!response.ok) {
    throw new ReleaseBinaryError(
      "checksums-missing",
      `no checksums.txt published beside ${asset} (HTTP ${response.status}), so it cannot be verified.`,
    );
  }
  const text = await response.text();
  const expected = text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    // `sha256sum` writes `<digest>  <name>` in text mode and `<digest> *<name>`
    // in binary mode; reading only the first spelling took an ordinary file for
    // one that lists nothing.
    .find((parts) => parts[1]?.replace(/^\*/, "") === asset)?.[0];
  if (!expected) {
    throw new ReleaseBinaryError(
      "checksum-unlisted",
      `checksums.txt beside ${asset} does not list it, so it cannot be verified.`,
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new ReleaseBinaryError(
      "checksum-mismatch",
      `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`,
    );
  }
}
