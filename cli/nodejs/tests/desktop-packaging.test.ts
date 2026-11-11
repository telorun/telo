import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DesktopHostUnavailable } from "../src/desktop/desktop-host-unavailable.js";
import { assertDesktopIcon, helperToPackage, pngSize, planDesktop } from "../src/package/desktop-packaging.js";
import { createLogger } from "../src/logger.js";

/** A PNG's leading bytes: signature, then an IHDR chunk of the given size. */
function pngHead(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-desktop-icon-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function icon(bytes: Buffer): string {
  const file = path.join(dir, "icon.png");
  fs.writeFileSync(file, bytes);
  return file;
}

describe("a PNG's size", () => {
  it("is read from the IHDR chunk alone", () => {
    expect(pngSize(pngHead(1024, 2048))).toEqual({ width: 1024, height: 2048 });
  });

  it("is nothing for bytes that are not a PNG, a truncated header, or a first chunk that is not IHDR", () => {
    expect(pngSize(Buffer.from("GIF89a, and then some more bytes to pass the length"))).toBeUndefined();
    expect(pngSize(pngHead(1024, 1024).subarray(0, 20))).toBeUndefined();
    const other = pngHead(1024, 1024);
    other.write("IDAT", 12, "ascii");
    expect(pngSize(other)).toBeUndefined();
  });
});

describe("the desktop icon check", () => {
  it("accepts a square PNG of at least 1024 px", () => {
    expect(() => assertDesktopIcon(icon(pngHead(1024, 1024)), "icon.png")).not.toThrow();
    expect(() => assertDesktopIcon(icon(pngHead(2048, 2048)), "icon.png")).not.toThrow();
  });

  it("refuses a small one with the file as written and the size found", () => {
    expect(() => assertDesktopIcon(icon(pngHead(512, 512)), "assets/icon.png")).toThrow(
      "[ERR_DESKTOP_ICON_INVALID] assets/icon.png must be square and at least 1024 px (it is 512 × 512)",
    );
  });

  it("refuses one that is not square, and a file that is not a PNG", () => {
    expect(() => assertDesktopIcon(icon(pngHead(1024, 2048)), "icon.png")).toThrow("it is 1024 × 2048");
    expect(() => assertDesktopIcon(icon(Buffer.from("not a png at all")), "icon.png")).toThrow(
      "[ERR_DESKTOP_ICON_INVALID] icon.png is not a PNG image",
    );
  });
});

describe("the helper to package", () => {
  const LOCATED = "/located/telo-desktop-host";
  const own = { hostTarget: "linux-amd64-gnu", checkout: { root: "/repo" }, version: "1.2.3" };

  function locator() {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      locate: (async (options: Record<string, unknown>) => {
        calls.push(options);
        return LOCATED;
      }) as never,
    };
  }

  it("is found as telo run finds it for the platform of this machine: the environment's, a checkout's build, the release", async () => {
    const seen = locator();
    const env = { TELO_HOST_DESKTOP_HELPER: "/fake" };
    await helperToPackage({ os: "linux", arch: "amd64", libc: "gnu" }, { ...own, env, locate: seen.locate });
    expect(seen.calls[0]).toMatchObject({ env, checkout: { root: "/repo" }, version: "1.2.3", target: "linux-amd64-gnu" });
  });

  it("is the release's for another platform, whatever this machine's environment and checkout would give", async () => {
    const seen = locator();
    await helperToPackage(
      { os: "windows", arch: "amd64" },
      { ...own, env: { TELO_HOST_DESKTOP_HELPER: "/fake", OTHER: "1" }, locate: seen.locate },
    );
    expect(seen.calls[0]).toMatchObject({ env: { OTHER: "1" }, checkout: null, target: "windows-amd64" });
  });

  it("refuses, naming that it is needed to package, when the helper cannot be obtained", async () => {
    const failing = (async () => {
      throw new DesktopHostUnavailable("telo-desktop-host-1.2.3-linux-amd64-gnu could not be downloaded (HTTP 503 from github.com)");
    }) as never;
    await expect(helperToPackage({ os: "linux", arch: "amd64", libc: "gnu" }, { ...own, locate: failing })).rejects.toThrow(
      "[ERR_DESKTOP_HOST_UNAVAILABLE] cannot package the desktop app: it carries the desktop host helper, which could not be obtained: " +
        "telo-desktop-host-1.2.3-linux-amd64-gnu could not be downloaded (HTTP 503 from github.com)",
    );
  });
});

describe("the desktop plan", () => {
  const log = createLogger(false);
  const fixtures = path.join(import.meta.dirname, "__fixtures__");

  it("is nothing for an application whose root declares no Telo.DesktopHost need", async () => {
    expect(
      await planDesktop(path.join(fixtures, "packaged-children", "child"), { os: "linux", arch: "amd64", libc: "gnu" }, { version: "1.0.0", log }),
    ).toBeUndefined();
  });

  it("reads the identity from the need and checks its icon before anything is obtained", async () => {
    // This fixture's icon is not an image, so the refusal precedes any helper lookup.
    await expect(
      planDesktop(path.join(fixtures, "desktop-host", "app"), { os: "linux", arch: "amd64", libc: "gnu" }, { version: "1.0.0", log }),
    ).rejects.toThrow("[ERR_DESKTOP_ICON_INVALID] icon.png is not a PNG image");
  });

  it("is the identity, the helper and the platform's bundle for a desktop app", async () => {
    const plan = await planDesktop(
      path.join(fixtures, "desktop-package", "app"),
      { os: "linux", arch: "amd64", libc: "gnu" },
      { version: "1.0.0", log, hostTarget: "linux-amd64-gnu", checkout: null, locate: (async () => "/located/helper") as never },
    );
    expect(plan).toMatchObject({
      identifier: "run.telo.tests.desktoppackage",
      identity: {
        identifier: "run.telo.tests.desktoppackage",
        productName: "Fixture",
        icon: path.join(fixtures, "desktop-package", "app", "icon.png"),
        showInDock: true,
      },
      helper: "/located/helper",
    });
    expect(plan?.bundle.helperInPayload).toBe(true);
  });
});
