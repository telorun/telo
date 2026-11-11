import * as fs from "node:fs";
import * as path from "node:path";
import { HELPER_FILE } from "./app-payload.js";
import { codesign, writeAppExecutable } from "./carrier.js";
import type { DesktopBundleInput, WrittenBundle } from "./desktop-bundle.js";
import { buildIcns } from "./macos-icns.js";
import { encodeInfoPlist, readPlistString, type PlistValue } from "./macos-info-plist.js";

/**
 * A macOS desktop app is an application bundle: `--out dist/Hello` writes
 * `dist/Hello.app`, whose `Contents/MacOS/` holds the carrier (named after the
 * product, its payload in its `TELO_APP` segment) and the helper beside it, and
 * whose `Info.plist` gives it the need's identity. The helper is not in the
 * payload: a bundle's code lives in `Contents/MacOS/`, which is what lets
 * `codesign --deep` sign and notarization accept both executables.
 */

export const APP_BUNDLE_SUFFIX = ".app";
/** The icon's file in `Contents/Resources/`, named by `CFBundleIconFile`. */
export const BUNDLE_ICON = "AppIcon";
/** The lowest macOS a bundle declares: the first with a per-app web view store. */
export const MINIMUM_MACOS = "14.0";

/** `dist/Hello` → `dist/Hello.app`; a path already ending in `.app` is kept. */
export function appBundlePath(out: string): string {
  return out.toLowerCase().endsWith(APP_BUNDLE_SUFFIX) ? out : `${out}${APP_BUNDLE_SUFFIX}`;
}

/**
 * The executable's file name: the product name with `/` and `:` (which a macOS
 * file name cannot hold or shows as each other) and control characters replaced
 * by `-`, surrounding space and leading dots removed. A name that leaves nothing
 * is the module's `metadata.name`.
 */
export function bundleExecutableName(productName: string, fallback: string): string {
  const cleaned = productName.replace(/[/:\u0000-\u001f\u007f]/g, "-").trim().replace(/^\.+/, "").trim();
  return cleaned || fallback;
}

/** `CFBundleShortVersionString` / `CFBundleVersion`: up to three period-separated integers. */
export function bundleVersion(version: string): string {
  const match = /^\d+(?:\.\d+){0,2}/.exec(version);
  if (!match) throw new Error(`metadata.version '${version}' does not begin with a number, so it cannot be a macOS bundle version.`);
  return match[0];
}

export function infoPlistFor(input: Pick<DesktopBundleInput, "identity" | "app">, executable: string): string {
  const { identity, app } = input;
  const version = app.version === undefined ? undefined : bundleVersion(app.version);
  const entries: Array<readonly [string, PlistValue]> = [
    ["CFBundleExecutable", executable],
    ["CFBundleIdentifier", identity.identifier],
    ["CFBundleName", identity.productName],
    ["CFBundleDisplayName", identity.productName],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleInfoDictionaryVersion", "6.0"],
    ...(version ? ([["CFBundleShortVersionString", version], ["CFBundleVersion", version]] as const) : []),
    ...(identity.icon ? ([["CFBundleIconFile", BUNDLE_ICON]] as const) : []),
    ["LSMinimumSystemVersion", MINIMUM_MACOS],
    ["NSHighResolutionCapable", true],
    ...(identity.showInDock ? [] : ([["LSUIElement", true]] as const)),
  ];
  return encodeInfoPlist(entries);
}

/** The executable of an application bundle at `dir`, or `undefined` when `dir` is not one. */
export function appBundleExecutable(dir: string): string | undefined {
  let plist: string;
  try {
    if (!fs.statSync(dir).isDirectory()) return undefined;
    plist = fs.readFileSync(path.join(dir, "Contents", "Info.plist"), "utf8");
  } catch {
    return undefined;
  }
  const executable = readPlistString(plist, "CFBundleExecutable");
  if (!executable || executable.includes("/") || executable === "." || executable === "..") return undefined;
  return path.join(dir, "Contents", "MacOS", executable);
}

/** What writing a bundle does to its two executables, replaceable so the layout is testable off a Mac. */
export interface MacosBundleSeams {
  /** Write the carrier with its payload at `out`. */
  placeExecutable(options: Parameters<typeof writeAppExecutable>[0]): Promise<void>;
  /** Sign `target` ad hoc. */
  sign(target: string): void;
}

const ON_A_MAC: MacosBundleSeams = {
  placeExecutable: writeAppExecutable,
  sign: (target) => codesign(["--force", "--sign", "-", target]),
};

/**
 * Write the bundle beside its destination and rename it into place, replacing
 * a bundle already there; anything else at that path is refused, and a failure
 * leaves no partial bundle behind. The helper and then the bundle are signed ad hoc, so
 * the bundle launches as written and an operator's `codesign` replaces both
 * signatures.
 */
export async function writeMacosAppBundle(input: DesktopBundleInput, seams: MacosBundleSeams = ON_A_MAC): Promise<WrittenBundle> {
  const bundle = appBundlePath(input.out);
  if (fs.existsSync(bundle) && appBundleExecutable(bundle) === undefined) {
    throw new Error(`${bundle} exists and is not an application bundle, so it is not replaced.`);
  }
  const name = bundleExecutableName(input.identity.productName, input.app.name);
  const staging = `${bundle}.${process.pid}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  let placed = false;
  try {
    const contents = path.join(staging, "Contents");
    const macos = path.join(contents, "MacOS");
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(contents, "Info.plist"), infoPlistFor(input, name));
    fs.writeFileSync(path.join(contents, "PkgInfo"), "APPL????");
    if (input.identity.icon) {
      const resources = path.join(contents, "Resources");
      fs.mkdirSync(resources, { recursive: true });
      fs.writeFileSync(path.join(resources, `${BUNDLE_ICON}.icns`), buildIcns(fs.readFileSync(input.identity.icon)));
    }
    await seams.placeExecutable({ carrier: input.carrier, payload: input.payload, out: path.join(macos, name), platform: input.platform });
    const helper = path.join(macos, HELPER_FILE);
    fs.copyFileSync(input.helper, helper);
    fs.chmodSync(helper, 0o755);
    seams.sign(helper);
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.renameSync(staging, bundle);
    placed = true;
    seams.sign(bundle);
  } catch (err) {
    fs.rmSync(placed ? bundle : staging, { recursive: true, force: true });
    throw err;
  }
  return { path: bundle, executable: path.join(bundle, "Contents", "MacOS", name) };
}
