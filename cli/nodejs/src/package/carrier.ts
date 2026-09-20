import { readTarGz } from "@telorun/kernel";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { distributionKind } from "../distribution-versions.js";
import { carriersRoot } from "./app-home.js";
import { APP_MAGIC, MACHO_SECTION, MACHO_SEGMENT, encodeTrailer } from "./app-trailer.js";
import { readZipEntry, zipEntryNames } from "./zip.js";
import type { PlatformLike } from "./app-payload.js";

/**
 * The carrier is the released `telo` binary for the platform, at this CLI's own
 * version — this executable itself when it IS that binary and the platform is
 * the host's, and the release asset otherwise.
 *
 * There is no flag naming a carrier file and no `--telo-version`: a carrier and
 * the CLI inside it are one version by construction, and a flag would be the
 * seam where they stop being. Packaging from a source checkout therefore goes
 * through that checkout's own standalone build, the way `telo runner`
 * supervises the running executable rather than a `telo` from `PATH`.
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
 * Assuming one shape for all of them is how packaging for Windows asked the
 * release for an asset that does not exist and reported it as a 404.
 *
 * `linux/arm64/musl` is absent because nodejs.org publishes no runtime to
 * inject into, so no carrier exists — said here rather than discovered as a
 * 404 at the download.
 */
const CARRIER_TARGETS: Record<string, { exe: string; archive: "tar.gz" | "zip" }> = {
  "linux-amd64-gnu": { exe: "", archive: "tar.gz" },
  "linux-amd64-musl": { exe: "", archive: "tar.gz" },
  "linux-arm64-gnu": { exe: "", archive: "tar.gz" },
  "darwin-amd64": { exe: "", archive: "tar.gz" },
  "darwin-arm64": { exe: "", archive: "tar.gz" },
  "windows-amd64": { exe: ".exe", archive: "zip" },
  "windows-arm64": { exe: ".exe", archive: "zip" },
};

/** Node's platform and architecture names in Telo's own vocabulary. Only the
 *  tuples a carrier exists for are named; everything else has no carrier. */
const OS_TOKENS: Record<string, string | undefined> = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows",
};
const ARCH_TOKENS: Record<string, string | undefined> = { x64: "amd64", arm64: "arm64" };

/** The release-asset spelling of a platform: `linux-amd64-gnu`. A filename in
 *  the download namespace, which is why `--platform` keeps the `os/arch/libc`
 *  spelling `telo install` uses and this is derived from it. */
export function carrierTarget(platform: PlatformLike): string {
  const libc = platform.os === "linux" ? (platform.libc ?? "gnu") : undefined;
  return [platform.os, platform.arch, libc].filter(Boolean).join("-");
}

export function carrierExtension(platform: PlatformLike): string {
  return CARRIER_TARGETS[carrierTarget(platform)]?.exe ?? "";
}

/** Refuse a platform no carrier exists for, naming the reason rather than
 *  letting the download decide. */
export function assertCarrierExists(platform: PlatformLike): void {
  const target = carrierTarget(platform);
  if (CARRIER_TARGETS[target]) return;
  const musl = platform.os === "linux" && platform.libc === "musl";
  throw new Error(
    `no telo binary is published for ${target}.` +
      (musl
        ? " nodejs.org publishes no musl runtime for this architecture, so there is nothing to build one from."
        : ` Published platforms: ${Object.keys(CARRIER_TARGETS).join(", ")}.`),
  );
}

export interface ResolvedCarrier {
  readonly file: string;
  readonly target: string;
  readonly from: "self" | "release";
}

/** Whether this process IS a single-file executable — the one case where the
 *  running program is itself a carrier. */
export function runningAsBinary(): boolean {
  try {
    return (createRequire(import.meta.url)("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

export function hostCarrierTarget(): string | null {
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

/**
 * Decide which carrier this packaging will use, and refuse here if it may not
 * have one — **before** the payload is built.
 *
 * Deciding early is not a nicety: every refusal on this path is a property of
 * the CLI and the platform alone, so asking after the build spends a minute of
 * warming and building on a question that was answerable at the first line.
 */
export function planCarrier(platform: PlatformLike, version: string): CarrierPlan {
  assertCarrierExists(platform);
  const target = carrierTarget(platform);
  if (runningAsBinary() && target === hostCarrierTarget()) {
    // This executable reads payloads by construction — it is the code doing the
    // packaging — so it needs neither the release check nor the probe.
    return { target, from: "self" };
  }
  assertMayDownloadCarrier(distributionKind(), target, version, {
    isBinary: runningAsBinary(),
    hostTarget: hostCarrierTarget(),
  });
  return { target, from: "release" };
}

export interface CarrierPlan {
  readonly target: string;
  readonly from: "self" | "release";
}

/** Obtain the planned carrier: this executable, or the release asset. */
export async function fetchCarrier(
  plan: CarrierPlan,
  version: string,
  report: (message: string) => void,
): Promise<ResolvedCarrier> {
  if (plan.from === "self") return { file: process.execPath, ...plan };
  const file = await downloadCarrier(plan.target, version, report);
  await assertCarrierReadsPayloads(file, plan.target, version);
  return { file, ...plan };
}

/**
 * A downloaded carrier is only honest when the CLI asking for it IS that
 * release.
 *
 * Downloading is right in one shape: a released telo packaging for a platform it
 * cannot build a carrier for. Everywhere else the version number is standing in
 * for an identity it does not have — a working copy and the release of the same
 * number are different code — so the app would carry the RELEASED telo while
 * claiming to carry the one that built it, and every local change under test
 * would be silently absent from it.
 *
 * So a working copy may package only what it can be the carrier for: itself,
 * built. That is one command away and it is the route the guide already gives.
 */
export function assertMayDownloadCarrier(
  kind: ReturnType<typeof distributionKind>,
  target: string,
  version: string,
  where: { isBinary: boolean; hostTarget: string | null } = { isBinary: false, hostTarget: null },
): void {
  if (kind === "release") return;
  const cause =
    kind === "checkout"
      ? `this telo is a build of its own, not the published ${version}`
      : `this telo cannot say whether it is the published ${version} or a build of its own`;
  // The remedy differs by where the reader is standing, and telling a binary to
  // build the binary it already is would be advice it has taken.
  const remedy = where.isBinary
    ? [
        `This binary can be the carrier for its own platform${where.hostTarget ? ` (${where.hostTarget})` : ""} and for no`,
        `other, since it cannot build another platform's runtime. Package ${target} with an`,
        `installed telo release — the one case where a downloaded carrier IS the telo doing the`,
        `packaging.`,
      ].join("\n")
    : [
        `Build this checkout's own binary and package with that:`,
        `  pnpm --filter @telorun/cli build:standalone`,
        `  ./cli/nodejs/dist-standalone/telo package <manifest> --out <file>`,
        `That binary is the carrier for its own platform, so what packages the app is what runs`,
        `it. Packaging for ANOTHER platform needs an installed telo release.`,
      ].join("\n");
  throw new Error(
    `packaging for ${target} would download the published telo ${version} and put your ` +
      `application inside it — but ${cause}, so the result would carry that release rather ` +
      `than the code that packaged it, and anything you changed here would be missing from ` +
      `it with nothing to show for it.\n${remedy}`,
  );
}

/**
 * Refuse a carrier that cannot read a payload.
 *
 * The carrier is always this CLI's own version, so this can only happen in one
 * window: a source checkout whose version is already published WITHOUT
 * `telo package`. Packaging then appends a payload to a binary that knows
 * nothing about payloads, and the result runs the CLI — a file that looks
 * packaged, reports its application under `inspect`, and silently is not one.
 *
 * Probed rather than versioned: the reader's own magic is a literal inside any
 * binary that carries it, so the question is asked of the bytes that will do the
 * reading instead of a floor someone has to remember to move when the release
 * number shifts. A BACKSTOP rather than the main guard — what keeps a downloaded
 * carrier honest is {@link assertMayDownloadCarrier}, which refuses the download
 * unless the CLI asking for it is that release; this catches the residue, a
 * released CLI whose own published binary predates the reader.
 */
async function assertCarrierReadsPayloads(
  file: string,
  target: string,
  version: string,
): Promise<void> {
  if (await carrierReadsPayloads(file)) return;
  throw new Error(
    `the published telo ${version} binary for ${target} cannot read a packaged application — ` +
      `it predates \`telo package\`, so appending a payload to it would produce a file that runs ` +
      `the CLI instead of the app.\nA packaged app carries the telo that built it, and that telo ` +
      `has to be one that knows how to read it. Either package with a telo from a release that ` +
      `carries this command, or build this checkout's own standalone binary ` +
      `(\`pnpm --filter @telorun/cli build:standalone\`) and run \`telo package\` from that.`,
  );
}

/** Whether a carrier carries the payload reader, answered by scanning it for the
 *  reader's own magic — in chunks with an overlap, so a 140 MB file is never
 *  held in memory and a magic straddling a chunk boundary is still found. */
export async function carrierReadsPayloads(file: string): Promise<boolean> {
  const handle = await fsp.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const chunk = Buffer.alloc(Math.min(size, 1024 * 1024));
    const overlap = APP_MAGIC.length - 1;
    let at = 0;
    let carry = Buffer.alloc(0);
    while (at < size) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, at);
      if (bytesRead <= 0) break;
      const window = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (window.includes(APP_MAGIC)) return true;
      carry = window.subarray(Math.max(0, window.length - overlap));
      at += bytesRead;
    }
    return false;
  } finally {
    await handle.close();
  }
}

/** The release asset for one target, verified against the release's own
 *  `checksums.txt` and kept in the user cache so a second packaging costs no
 *  download. */
async function downloadCarrier(
  target: string,
  version: string,
  report: (message: string) => void,
): Promise<string> {
  const spec = CARRIER_TARGETS[target];
  const root = carriersRoot();
  const cached = root ? path.join(root, version, `telo-${target}${spec.exe}`) : undefined;
  if (cached && fs.existsSync(cached)) return cached;

  const asset = `telo-${version}-${target}.${spec.archive}`;
  const base = `https://github.com/${RELEASE_REPO}/releases/download/v${version}`;
  report(`fetching ${base}/${asset}`);
  const response = await fetch(`${base}/${asset}`);
  if (!response.ok) {
    throw new Error(
      `no telo ${version} binary for ${target} at ${base}/${asset} (HTTP ${response.status}). ` +
        `A packaged app carries the telo that built it, so packaging needs a released one — ` +
        `either run this from a released telo, or build the standalone binary in this checkout ` +
        `and package with that.`,
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  await verifyChecksum(base, asset, archive);

  const binary = await carrierFromArchive(archive, asset, target, version);
  if (!cached) {
    throw new Error(
      `no writable cache directory for the downloaded carrier. Set TELO_APP_DIR to a writable path.`,
    );
  }
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, binary, { mode: 0o755 });
  return cached;
}

/** The binary inside a release asset, at the path that asset's own format puts
 *  it — the two differ, and the archive says which one it is. */
async function carrierFromArchive(
  archive: Buffer,
  asset: string,
  target: string,
  version: string,
): Promise<Buffer> {
  const spec = CARRIER_TARGETS[target];
  if (spec.archive === "zip") {
    const wanted = `telo${spec.exe}`;
    const entry = readZipEntry(archive, wanted);
    if (!entry) {
      throw new Error(`${asset} does not contain ${wanted} (it holds ${zipEntryNames(archive).join(", ")})`);
    }
    return entry.contents;
  }
  const wanted = `telo-${version}-${target}/telo${spec.exe}`;
  for (const entry of await readTarGz(archive)) {
    if (entry.name !== wanted || "link" in entry) continue;
    return Buffer.from(entry.content);
  }
  throw new Error(`${asset} does not contain ${wanted}`);
}

/**
 * The release publishes one `checksums.txt` covering every asset, and this
 * download is **verified or refused**.
 *
 * Continuing unverified would bake a network-fetched executable into someone's
 * product on the strength of nothing. A release that ought to carry checksums
 * and does not is a condition to stop at, not to note in passing — and since
 * only a released telo may download a carrier at all, every reachable release is
 * one that publishes them.
 */
async function verifyChecksum(base: string, asset: string, bytes: Buffer): Promise<void> {
  const response = await fetch(`${base}/checksums.txt`);
  if (!response.ok) {
    throw new Error(
      `no checksums.txt published beside ${asset} (HTTP ${response.status}), so the carrier ` +
        `cannot be verified — and a carrier becomes part of every application packaged with it.`,
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
    throw new Error(`checksums.txt beside ${asset} does not list it, so it cannot be verified.`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }
}

/**
 * Write the packaged executable: the carrier's bytes, with the payload placed
 * the way this executable format allows.
 *
 * ELF and PE take it appended. Mach-O does not — data after `__LINKEDIT` is
 * what "main executable failed strict validation" means, and an unsigned arm64
 * binary does not launch — so there it goes into a segment of its own, through
 * the same tool the standalone build already drives, with the ad-hoc signature
 * taken off first and put back after.
 */
export async function writeAppExecutable(options: {
  carrier: string;
  payload: Buffer;
  out: string;
  platform: PlatformLike;
}): Promise<void> {
  const { carrier, payload, out, platform } = options;
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.copyFileSync(carrier, out);
  fs.chmodSync(out, 0o755);

  const trailed = Buffer.concat([payload, encodeTrailer(payload)]);
  if (platform.os !== "darwin") {
    fs.appendFileSync(out, trailed);
    return;
  }

  if (process.platform !== "darwin") {
    throw new Error(
      `packaging for ${carrierTarget(platform)} requires a macOS host: the payload goes into a ` +
        `Mach-O segment and the binary has to be re-signed afterwards, which only codesign does. ` +
        `Package darwin platforms on a Mac.`,
    );
  }
  codesign(["--remove-signature", out]);
  const { inject } = await import("postject");
  await inject(out, MACHO_SECTION, trailed, {
    machoSegmentName: MACHO_SEGMENT,
    overwrite: true,
  });
  codesign(["--sign", "-", out]);
}

function codesign(args: string[]): void {
  try {
    execFileSync("codesign", args, { stdio: "inherit" });
  } catch (err) {
    throw new Error(
      `"codesign ${args.join(" ")}" failed (${(err as Error)?.message ?? err}). ` +
        `A macOS build needs Xcode's command line tools.`,
    );
  }
}
