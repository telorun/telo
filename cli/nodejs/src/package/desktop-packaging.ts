import * as fs from "node:fs";
import { DesktopHostUnavailable, DESKTOP_HOST_UNAVAILABLE } from "../desktop/desktop-host-unavailable.js";
import { detectCheckout, locateHelper } from "../desktop/desktop-helper-location.js";
import { DESKTOP_HELPER_HOST_VALUE } from "@telorun/kernel";
import { readDesktopHostNeed } from "../desktop/desktop-host-need.js";
import type { Logger } from "../logger.js";
import { hostReleaseTarget } from "../release-binary.js";
import type { PlatformLike } from "./app-payload.js";
import { carrierTarget } from "./carrier.js";
import {
  desktopBundleWriterFor,
  payloadHelperName,
  type DesktopBundleWriter,
  type DesktopIdentity,
} from "./desktop-bundle.js";

/**
 * What `telo package` owes a desktop app beyond a server's: the icon is checked
 * before anything is built, and the helper is obtained for the platform being
 * packaged. A refusal is a sentence prefixed with its code, as every packaging
 * refusal is a message.
 */

export const DESKTOP_ICON_INVALID = "ERR_DESKTOP_ICON_INVALID";
/** The smallest side of the icon: the largest size a platform's icon format holds. */
export const MINIMUM_ICON_SIZE = 1024;

export class DesktopPackagingRefusal extends Error {
  constructor(
    readonly code: string,
    text: string,
  ) {
    super(`[${code}] ${text}`);
    this.name = "DesktopPackagingRefusal";
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Signature, the IHDR chunk's length and type, then width and height. */
const IHDR_END = 8 + 4 + 4 + 4 + 4;

/** A PNG's pixel size from its IHDR chunk — the first chunk, read without decoding the image — or `undefined` for bytes that are not one. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const head = Buffer.from(bytes.subarray(0, IHDR_END));
  if (head.length < IHDR_END || !head.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (head.readUInt32BE(8) !== 13 || head.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/**
 * Refuse an icon that is not a square PNG of at least 1024 px. `written` is the
 * path as the manifest wrote it, which is what the author searches for.
 */
export function assertDesktopIcon(file: string, written: string): void {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new DesktopPackagingRefusal(DESKTOP_ICON_INVALID, `${written} cannot be read (${(err as Error).message})`);
  }
  const size = pngSize(bytes);
  if (!size) {
    throw new DesktopPackagingRefusal(DESKTOP_ICON_INVALID, `${written} is not a PNG image`);
  }
  if (size.width !== size.height || size.width < MINIMUM_ICON_SIZE) {
    throw new DesktopPackagingRefusal(
      DESKTOP_ICON_INVALID,
      `${written} must be square and at least ${MINIMUM_ICON_SIZE} px (it is ${size.width} × ${size.height})`,
    );
  }
}

export interface PackagedHelperOptions {
  /** The CLI's version, which names the release the helper comes from. */
  version: string;
  env?: NodeJS.ProcessEnv;
  report?: (message: string) => void;
  /** Overridable for tests: the target of the machine packaging. */
  hostTarget?: string | null;
  checkout?: ReturnType<typeof detectCheckout>;
  locate?: typeof locateHelper;
}

/**
 * The helper binary for the platform being packaged, located as `telo run`
 * locates its own: the environment's `TELO_HOST_DESKTOP_HELPER`, a checkout's
 * cargo build, else the release download. The first two are binaries of THIS
 * machine, so packaging for another platform ignores both and downloads.
 */
export async function helperToPackage(platform: PlatformLike, options: PackagedHelperOptions): Promise<string> {
  const target = carrierTarget(platform);
  const ownPlatform = target === (options.hostTarget === undefined ? hostReleaseTarget() : options.hostTarget);
  const env = { ...(options.env ?? process.env) };
  if (!ownPlatform) delete env[DESKTOP_HELPER_HOST_VALUE];
  try {
    return await (options.locate ?? locateHelper)({
      env,
      checkout: ownPlatform ? (options.checkout === undefined ? detectCheckout() : options.checkout) : null,
      version: options.version,
      target,
      ...(options.report ? { report: options.report } : {}),
    });
  } catch (err) {
    if (!(err instanceof DesktopHostUnavailable)) throw err;
    throw new DesktopPackagingRefusal(
      DESKTOP_HOST_UNAVAILABLE,
      `cannot package the desktop app: it carries the desktop host helper, which could not be obtained: ${err.reason}`,
    );
  }
}

/** A desktop app's packaging decisions, made before anything is built. */
export interface DesktopPlan {
  readonly identifier: string;
  /** What the platform's bundle is written from. */
  readonly identity: DesktopIdentity;
  /** The helper binary for the platform. */
  readonly helper: string;
  readonly bundle: DesktopBundleWriter;
}

export interface DesktopPlanOptions extends PackagedHelperOptions {
  log: Logger;
}

/**
 * Whether `manifest` is a desktop app — its root declares a `Telo.DesktopHost`
 * need, read from the need table, whatever the environment supplies — and, when
 * it is, the icon checked and the helper obtained. `undefined` for any other
 * application, which packages as it always did.
 */
export async function planDesktop(
  manifest: string,
  platform: PlatformLike,
  options: DesktopPlanOptions,
): Promise<DesktopPlan | undefined> {
  const reading = await readDesktopHostNeed(manifest, manifest, {}, options.log);
  if (reading.kind === "refused") throw new Error(`${manifest} was refused (see above), so it cannot be packaged.`);
  if (reading.kind === "none") return undefined;
  const { need } = reading;
  if (need.icon && need.iconSource) assertDesktopIcon(need.icon, need.iconSource);
  return {
    identifier: need.identifier,
    identity: {
      identifier: need.identifier,
      productName: need.productName,
      ...(need.icon ? { icon: need.icon } : {}),
      showInDock: need.showInDock,
    },
    helper: await helperToPackage(platform, options),
    bundle: desktopBundleWriterFor(platform.os),
  };
}

/** What the payload builder is told of a desktop app: its identity and, when the platform's bundle keeps it there, the helper to carry. */
export function payloadDesktop(plan: DesktopPlan, platform: PlatformLike) {
  return {
    identifier: plan.identifier,
    ...(plan.bundle.helperInPayload ? { helper: { file: plan.helper, name: payloadHelperName(platform.os) } } : {}),
  };
}
