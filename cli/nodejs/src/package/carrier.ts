import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { distributionKind } from "../distribution-versions.js";
import { carriersRoot } from "./app-home.js";
import { APP_MAGIC, MACHO_SECTION, MACHO_SEGMENT, encodeTrailer } from "./app-trailer.js";
import {
  hostReleaseTarget,
  RELEASE_BINARY_TARGETS,
  releaseBinary,
  ReleaseBinaryError,
} from "../release-binary.js";
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

/** A carrier is the release binary of a platform — one table, read by both. */
const CARRIER_TARGETS = RELEASE_BINARY_TARGETS;

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
  return hostReleaseTarget();
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

/** The release binary for one target — fetched, verified and cached by the
 *  shared release fetch — with what its absence means for a packaging. */
async function downloadCarrier(
  target: string,
  version: string,
  report: (message: string) => void,
): Promise<string> {
  try {
    return await releaseBinary(target, version, { cacheRoot: carriersRoot(), report });
  } catch (err) {
    if (!(err instanceof ReleaseBinaryError)) throw err;
    if (err.failure === "not-published" || err.failure === "unreachable") {
      throw new Error(
        `${err.message} A packaged app carries the telo that built it, so packaging needs a ` +
          `released one — either run this from a released telo, or build the standalone binary ` +
          `in this checkout and package with that.`,
      );
    }
    if (err.failure === "checksums-missing") {
      throw new Error(
        `${err.message} A carrier becomes part of every application packaged with it.`,
      );
    }
    throw err;
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
