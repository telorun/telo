import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeTrailer } from "../src/package/app-trailer.js";
import { writeAppExecutable } from "../src/package/carrier.js";
import { desktopBundleWriterFor } from "../src/package/desktop-bundle.js";
import { fabricatePe, parsePe } from "./__fixtures__/pe/pe-fixture.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-desktop-bundle-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const payload = Buffer.from("payload bytes");
const identity = { identifier: "run.telo.hello", productName: "Hello", showInDock: true };

describe("the bundle a desktop app is written as", () => {
  it("is the platform's own: a bundle keeping the helper beside the carrier on macOS, a GUI executable on Windows, the plain executable on Linux", async () => {
    expect(desktopBundleWriterFor("darwin").helperInPayload).toBe(false);
    expect(desktopBundleWriterFor("linux").helperInPayload).toBe(true);
    const carrier = path.join(dir, "carrier.exe");
    fs.writeFileSync(carrier, fabricatePe());
    const out = path.join(dir, "Hello.exe");
    const windows = desktopBundleWriterFor("windows");
    expect(windows.helperInPayload).toBe(true);
    expect(await windows.write({ carrier, payload, out, platform: { os: "windows", arch: "amd64" }, helper: carrier, identity, app: { name: "Hello" } })).toEqual({ path: out, executable: out });
    expect(parsePe(fs.readFileSync(out)).subsystem).toBe(2);
  });

  it("leaves an application that is not a desktop app as it was: the carrier, the payload and the trailer", async () => {
    const carrier = path.join(dir, "carrier.exe");
    const bytes = fabricatePe();
    fs.writeFileSync(carrier, bytes);
    const out = path.join(dir, "orders.exe");
    await writeAppExecutable({ carrier, payload, out, platform: { os: "windows", arch: "amd64" } });
    expect(fs.readFileSync(out).equals(Buffer.concat([bytes, payload, encodeTrailer(payload)]))).toBe(true);
  });
});
