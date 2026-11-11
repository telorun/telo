import * as fs from "node:fs";
import * as path from "node:path";
import { HELPER_FILE, HELPER_PREFIX, type PlatformLike } from "./app-payload.js";
import type { PackagedApp } from "./app-unpack.js";
import { writeAppExecutable } from "./carrier.js";
import { writeMacosAppBundle } from "./macos-app-bundle.js";
import { buildWindowsGuiExecutable } from "./windows-gui-executable.js";

/**
 * What differs per platform when a desktop app is packaged: where the helper
 * rides and how the output is laid down. Everything else — detection, the icon
 * check, the payload — is one code path, so a platform's bundle format is one
 * entry in each table below and nothing else.
 *
 * Linux writes the plain executable with the helper in the payload; macOS an
 * application bundle with the helper beside the carrier; Windows a GUI-subsystem
 * executable carrying its icon, its version and its payload as resources, the
 * helper in the payload.
 */

/** The identity a desktop app's bundle is written from, read from its `Telo.DesktopHost` need. */
export interface DesktopIdentity {
  readonly identifier: string;
  readonly productName: string;
  /** The PNG, absolute; absent when the need names none. */
  readonly icon?: string;
  readonly showInDock: boolean;
}

/** What a writer is handed. */
export interface DesktopBundleInput {
  /** The carrier binary the output is made from. */
  readonly carrier: string;
  /** The packed payload; it holds the helper when {@link DesktopBundleWriter.helperInPayload}. */
  readonly payload: Buffer;
  /** The path `--out` named, with the carrier's extension. */
  readonly out: string;
  readonly platform: PlatformLike;
  /** The helper binary packaged for the platform. */
  readonly helper: string;
  readonly identity: DesktopIdentity;
  /** The root module's `metadata` name and version, as the payload index records them. */
  readonly app: { readonly name: string; readonly version?: string };
}

/** What a writer wrote: the output (a file, or a bundle directory) and the executable inside it. */
export interface WrittenBundle {
  readonly path: string;
  readonly executable: string;
}

export interface DesktopBundleWriter {
  /** Whether the helper is an entry of the payload (at {@link payloadHelperName}); a writer that places it beside the carrier says `false`. */
  readonly helperInPayload: boolean;
  write(input: DesktopBundleInput): Promise<WrittenBundle>;
}

const EXECUTABLE_BUNDLE: DesktopBundleWriter = {
  helperInPayload: true,
  write: async ({ carrier, payload, out, platform }) => {
    await writeAppExecutable({ carrier, payload, out, platform });
    return { path: out, executable: out };
  },
};

const MACOS_APP_BUNDLE: DesktopBundleWriter = {
  helperInPayload: false,
  write: (input) => writeMacosAppBundle(input),
};

const WINDOWS_GUI_EXECUTABLE: DesktopBundleWriter = {
  helperInPayload: true,
  write: async ({ carrier, payload, out, identity, app }) => {
    const bytes = await buildWindowsGuiExecutable({
      carrier: fs.readFileSync(carrier),
      payload,
      ...(identity.icon ? { icon: fs.readFileSync(identity.icon) } : {}),
      version: { productName: identity.productName, ...(app.version !== undefined ? { version: app.version } : {}) },
    });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, bytes, { mode: 0o755 });
    fs.chmodSync(out, 0o755);
    return { path: out, executable: out };
  },
};

/** A platform's own bundle, by `os` (`darwin`, `linux`, `windows`); absent means the plain executable. */
const BUNDLE_WRITERS: Readonly<Record<string, DesktopBundleWriter | undefined>> = {
  darwin: MACOS_APP_BUNDLE,
  windows: WINDOWS_GUI_EXECUTABLE,
};

export function desktopBundleWriterFor(os: string | undefined): DesktopBundleWriter {
  return (os ? BUNDLE_WRITERS[os] : undefined) ?? EXECUTABLE_BUNDLE;
}

/** The helper's payload-relative name: `helper/telo-desktop-host`, `.exe` for Windows. */
export function payloadHelperName(os: string | undefined): string {
  return `${HELPER_PREFIX}/${HELPER_FILE}${os === "windows" ? ".exe" : ""}`;
}

/** What locating the helper reads of a packaged app: where it is unpacked and what carries it. */
export type PackagedHelperSource = Pick<PackagedApp, "dir" | "index" | "executable">;

/** Where a packaged app of one platform has its helper on disk, when not in the unpacked tree. */
const HELPER_LOCATIONS: Readonly<Record<string, ((app: PackagedHelperSource) => string) | undefined>> = {
  // `Contents/MacOS/telo-desktop-host`, beside the carrier the bundle starts.
  darwin: (app) => path.join(path.dirname(app.executable), HELPER_FILE),
};

/**
 * The helper a packaged desktop app carries — the `packagedHelperPath` the host
 * locates its helper with — or `undefined` for an app that is not one. The
 * answer is per the platform the payload was packaged for.
 */
export function packagedHelperPath(app: PackagedHelperSource): string | undefined {
  if (!app.index.desktopHost) return undefined;
  const os = app.index.platform.os;
  const place = HELPER_LOCATIONS[os];
  return place ? place(app) : path.join(app.dir, ...payloadHelperName(os).split("/"));
}
