import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeTarGz } from "@telorun/kernel";
import { readEmbeddedPayload } from "../src/package/app-trailer.js";
import { writeAppExecutable } from "../src/package/carrier.js";
import type { DesktopBundleInput } from "../src/package/desktop-bundle.js";
import { buildIcns, ICNS_ENTRIES } from "../src/package/macos-icns.js";
import { bundleExecutableName, writeMacosAppBundle } from "../src/package/macos-app-bundle.js";

/**
 * The macOS application bundle, laid down off a Mac: the carrier's placement
 * and the signing are the two steps only macOS performs, so they are stood in
 * for here — the payload appended as on ELF, the signatures recorded — and the
 * layout, `Info.plist` and `.icns` are read back as bytes.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/telo.mjs");

let dir: string;
let icon: string;
beforeAll(() => {
  const png = new PNG({ width: 2048, height: 2048 });
  png.data.fill(0x80);
  icon = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telo-macos-icon-")), "icon.png");
  fs.writeFileSync(icon, PNG.sync.write(png, { colorType: 6 }));
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-macos-bundle-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A property list's top-level keys and their string or boolean values, read with a pattern of its own. */
function plist(file: string): Record<string, string | boolean> {
  const xml = fs.readFileSync(file, "utf8");
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
  const values: Record<string, string | boolean> = {};
  for (const [, key, text, bool] of xml.matchAll(/<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<(true|false)\/>)/g)) {
    const unescape = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    values[unescape(key!)] = bool !== undefined ? bool === "true" : unescape(text!);
  }
  return values;
}

async function bundle(overrides: Partial<DesktopBundleInput["identity"]> = {}, app: DesktopBundleInput["app"] = { name: "HelloDesktop", version: "1.2.3" }) {
  const carrier = path.join(dir, "carrier");
  fs.writeFileSync(carrier, Buffer.alloc(64, 1));
  const helper = path.join(dir, "helper");
  fs.writeFileSync(helper, "helper bytes");
  const signed: string[] = [];
  const payload = await makeTarGz([{ name: "telo-app.json", content: JSON.stringify({ format: 1, app }) }]);
  const written = await writeMacosAppBundle(
    {
      carrier,
      payload,
      out: path.join(dir, "dist", "Hello"),
      platform: { os: "darwin", arch: "arm64" },
      helper,
      identity: { identifier: "run.telo.hello", productName: "Hello", icon, showInDock: true, ...overrides },
      app,
    },
    {
      placeExecutable: (options) => writeAppExecutable({ ...options, platform: { os: "linux", arch: "amd64" } }),
      sign: (target) => signed.push(path.relative(dir, target)),
    },
  );
  return { written, signed, payload };
}

describe("a macOS desktop app", () => {
  it("is an application bundle with the carrier and the helper in Contents/MacOS, both executable and signed", async () => {
    const { written, signed, payload } = await bundle();
    const app = path.join(dir, "dist", "Hello.app");
    expect(written).toEqual({ path: app, executable: path.join(app, "Contents", "MacOS", "Hello") });
    expect(fs.readdirSync(path.join(app, "Contents")).sort()).toEqual(["Info.plist", "MacOS", "PkgInfo", "Resources"]);
    expect(fs.readdirSync(path.join(app, "Contents", "MacOS")).sort()).toEqual(["Hello", "telo-desktop-host"]);
    // A Windows filesystem carries no execute bit to read back.
    if (process.platform !== "win32") {
      for (const file of ["Hello", "telo-desktop-host"]) {
        expect(fs.statSync(path.join(app, "Contents", "MacOS", file)).mode & 0o111).toBe(0o111);
      }
    }
    expect(fs.readFileSync(path.join(app, "Contents", "PkgInfo"), "utf8")).toBe("APPL????");
    expect((await readEmbeddedPayload(written.executable))?.bytes.equals(payload)).toBe(true);
    expect(signed).toEqual([path.join("dist", `Hello.app.${process.pid}.tmp`, "Contents", "MacOS", "telo-desktop-host"), path.join("dist", "Hello.app")]);
  });

  it("states the need's identity in Info.plist", async () => {
    await bundle();
    expect(plist(path.join(dir, "dist", "Hello.app", "Contents", "Info.plist"))).toEqual({
      CFBundleExecutable: "Hello",
      CFBundleIdentifier: "run.telo.hello",
      CFBundleName: "Hello",
      CFBundleDisplayName: "Hello",
      CFBundlePackageType: "APPL",
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleShortVersionString: "1.2.3",
      CFBundleVersion: "1.2.3",
      CFBundleIconFile: "AppIcon",
      LSMinimumSystemVersion: "14.0",
      NSHighResolutionCapable: true,
    });
  });

  // `<` and `>` in the executable name are not file names on a Windows filesystem.
  it.skipIf(process.platform === "win32")("hides from the Dock, escapes the product name and names the executable after it", async () => {
    await bundle({ productName: "Tom & Jerry <Beta>: 2/3", showInDock: false, icon: undefined }, { name: "HelloDesktop" });
    const values = plist(path.join(dir, "dist", "Hello.app", "Contents", "Info.plist"));
    expect(values).toMatchObject({ CFBundleName: "Tom & Jerry <Beta>: 2/3", CFBundleExecutable: "Tom & Jerry <Beta>- 2-3", LSUIElement: true });
    expect(Object.keys(values)).not.toContain("CFBundleShortVersionString");
    expect(Object.keys(values)).not.toContain("CFBundleIconFile");
    expect(fs.existsSync(path.join(dir, "dist", "Hello.app", "Contents", "MacOS", "Tom & Jerry <Beta>- 2-3"))).toBe(true);
    expect(bundleExecutableName(" ...", "HelloDesktop")).toBe("HelloDesktop");
  });

  it("replaces a bundle already at the path, and refuses anything else there", async () => {
    await bundle();
    fs.writeFileSync(path.join(dir, "dist", "Hello.app", "Contents", "stale"), "");
    await bundle();
    expect(fs.existsSync(path.join(dir, "dist", "Hello.app", "Contents", "stale"))).toBe(false);
    fs.rmSync(path.join(dir, "dist", "Hello.app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "Hello.app"), "a file");
    await expect(bundle()).rejects.toThrow("exists and is not an application bundle");
  });

  it("is read by package inspect through the bundle's path", async () => {
    await bundle();
    const printed = JSON.parse(execFileSync(process.execPath, [CLI, "package", "inspect", path.join(dir, "dist", "Hello.app")], { encoding: "utf8" }));
    expect(printed.app).toEqual({ name: "HelloDesktop", version: "1.2.3" });
  }, 60_000);
});

describe("the .icns", () => {
  function entries(icns: Buffer) {
    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const found: Array<{ type: string; data: Buffer }> = [];
    for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) {
      found.push({ type: icns.toString("ascii", at, at + 4), data: icns.subarray(at + 8, at + icns.readUInt32BE(at + 4)) });
    }
    return found;
  }

  it("holds a PNG of each size, downscaled from a larger icon", () => {
    const found = entries(buildIcns(fs.readFileSync(icon)));
    expect(found.map((entry) => [entry.type, PNG.sync.read(entry.data).width])).toEqual(ICNS_ENTRIES);
  });

  it("holds a 1024 px icon's own bytes as ic10", () => {
    const png = new PNG({ width: 1024, height: 1024 });
    const bytes = PNG.sync.write(png, { colorType: 6 });
    expect(entries(buildIcns(bytes)).find((entry) => entry.type === "ic10")!.data.equals(bytes)).toBe(true);
  });
});
