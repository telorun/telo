import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";
import { readEmbeddedPayload } from "../src/package/app-trailer.js";
import { readPayloadIndex } from "../src/package/app-payload.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";
import { payloadDesktop, planDesktop } from "../src/package/desktop-packaging.js";
import { opened, scratch, telo, until, useHarness } from "./__fixtures__/desktop-host/harness.js";

/**
 * A desktop app packaged for Linux: the helper rides in the payload and is the
 * one a start of the executable runs, the per-user directory is its working
 * directory and `.env` home, and its state lives beneath it. The carrier is a
 * stand-in file (a release binary cannot be downloaded here), which is all the
 * payload reader needs; the fake helper stands in for the real one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../bin/telo.mjs");
const FAKE = path.join(HERE, "__fixtures__", "desktop-helper", "fake-desktop-helper.mjs");
const DESKTOP = path.join(HERE, "__fixtures__", "desktop-package", "app");
const PLAIN = path.join(HERE, "__fixtures__", "packaged-children", "child");
const PLATFORM = { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" };
const IDENTIFIER = "run.telo.tests.desktoppackage";

useHarness();

let dir: string;
let executable: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-desktop-package-"));
  const plan = await planDesktop(DESKTOP, PLATFORM, {
    version: "1.0.0",
    log: createLogger(false),
    env: { TELO_HOST_DESKTOP_HELPER: FAKE },
    hostTarget: "linux-amd64-gnu",
    checkout: null,
  });
  const { payload, index } = await buildAppPayload({
    manifestPath: DESKTOP,
    platform: PLATFORM,
    report: () => {},
    desktop: payloadDesktop(plan!, PLATFORM),
  });
  const carrier = path.join(dir, "carrier");
  fs.writeFileSync(carrier, Buffer.alloc(64, 1));
  executable = path.join(dir, "Hello");
  await plan!.bundle.write({ carrier, payload, out: executable, platform: PLATFORM, helper: plan!.helper, identity: plan!.identity, app: index.app });
}, 120_000);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the payload index", () => {
  it("names the identity of a desktop app between the analysis key and the modules, and inspect prints it", () => {
    const printed = JSON.parse(execFileSync(process.execPath, [CLI, "package", "inspect", executable], { encoding: "utf8" }));
    expect(Object.keys(printed)).toEqual(["format", "app", "entry", "platform", "telo", "analysisKey", "desktopHost", "modules", "payload"]);
    expect(printed.format).toBe(1);
    expect(printed.desktopHost).toEqual({ identifier: IDENTIFIER });
  }, 60_000);

  it("is the index every application had for one that is not a desktop app", async () => {
    const { index } = await buildAppPayload({ manifestPath: PLAIN, platform: PLATFORM, report: () => {} });
    expect(Object.keys(index)).toEqual(["format", "app", "entry", "platform", "telo", "analysisKey", "modules"]);
  }, 120_000);

  it("carries the helper at its fixed path, executable, and no other file of the machine", async () => {
    const payload = await readEmbeddedPayload(executable);
    const { readTarGz } = await import("@telorun/kernel");
    const helper = (await readTarGz(payload!.bytes)).find((entry) => entry.name === "helper/telo-desktop-host");
    expect(helper && "content" in helper && helper.executable).toBe(true);
    expect((await readPayloadIndex(payload!.bytes)).desktopHost?.identifier).toBe(IDENTIFIER);
  });
});

describe.skipIf(process.platform === "win32")("a start of the packaged desktop app", () => {
  /** The environment of a start: no helper named, so only the payload's can be run. */
  function start(session: ReturnType<typeof scratch>, extra: Record<string, string> = {}) {
    return telo(executable, { ...session.env, TELO_HOST_DESKTOP_HELPER: "", TELO_APP_DIR: path.join(dir, "unpacked"), ...extra });
  }

  it("runs the helper it carries and keeps the kernel's state in the per-user directory", async () => {
    const session = scratch();
    const run = start(session);
    await opened(session.log, "mainWindow");
    const appDirectory = path.join(session.dataRoot, IDENTIFIER);
    const data = path.join(appDirectory, "state", "needs", "data");
    await until("the report line", () => run.stdout().includes(`data=${data}`));
    expect(fs.statSync(data).isDirectory()).toBe(true);
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
    expect(fs.readdirSync(path.join(appDirectory, "desktop-host")).sort()).toEqual(["port", "webview"]);
  }, 120_000);

  it("reads its .env from the per-user directory, which may name a state directory of its own", async () => {
    const session = scratch();
    const appDirectory = path.join(session.dataRoot, IDENTIFIER);
    fs.mkdirSync(appDirectory, { recursive: true });
    const state = path.join(session.dir, "elsewhere");
    fs.writeFileSync(path.join(appDirectory, ".env"), `TELO_HOST_STATE_DIR=${state}\n`);
    const run = start(session);
    await opened(session.log, "mainWindow");
    await until("the report line", () => run.stdout().includes(`data=${path.join(state, "needs", "data")}`));
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
    expect(fs.existsSync(path.join(appDirectory, "state"))).toBe(false);
  }, 120_000);
});

