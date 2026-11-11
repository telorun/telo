import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enterPackagedDesktopStart } from "../src/desktop/desktop-packaged-start.js";
import { packagedHelperPath, payloadHelperName } from "../src/package/desktop-bundle.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-packaged-start-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("a packaged desktop app hosting itself", () => {
  it("works in the per-user directory of its identifier and keeps its state beneath it", () => {
    const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: dir };
    const moved: string[] = [];
    const entered = enterPackagedDesktopStart({ identifier: "run.telo.hello", env, platform: "linux", chdir: (to) => moved.push(to) });
    const appDirectory = path.join(dir, "run.telo.hello");
    expect(entered).toEqual({ appDirectory, stateDirectory: path.join(appDirectory, "state") });
    expect(moved).toEqual([appDirectory]);
    expect(fs.statSync(appDirectory).isDirectory()).toBe(true);
    expect(env.TELO_HOST_STATE_DIR).toBe(path.join(appDirectory, "state"));
  });

  it("keeps a state directory the environment already names", () => {
    const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: dir, TELO_HOST_STATE_DIR: "/srv/state" };
    const entered = enterPackagedDesktopStart({ identifier: "run.telo.hello", env, platform: "linux", chdir: () => {} });
    expect(env.TELO_HOST_STATE_DIR).toBe("/srv/state");
    expect(entered.stateDirectory).toBe("/srv/state");
  });

  it("is refused where the platform names no per-user directory", () => {
    expect(() => enterPackagedDesktopStart({ identifier: "run.telo.hello", env: {}, platform: "win32", chdir: () => {} })).toThrow(
      "no per-user directory",
    );
  });
});

describe("the helper a packaged app carries", () => {
  const app = (desktop: boolean, os: string) =>
    ({
      dir: "/unpacked/App-1",
      executable: "/bin/app",
      index: { platform: { os }, ...(desktop ? { desktopHost: { identifier: "a.b" } } : {}) },
    }) as never;

  it("is at one fixed payload path, unpacked with the tree, for an app that is a desktop app", () => {
    expect(payloadHelperName("linux")).toBe("helper/telo-desktop-host");
    expect(payloadHelperName("windows")).toBe("helper/telo-desktop-host.exe");
    expect(packagedHelperPath(app(true, "linux"))).toBe(path.join("/unpacked/App-1", "helper", "telo-desktop-host"));
    expect(packagedHelperPath(app(true, "windows"))).toBe(path.join("/unpacked/App-1", "helper", "telo-desktop-host.exe"));
  });

  it("is beside the carrier in the bundle's Contents/MacOS for a macOS app", () => {
    expect(packagedHelperPath(app(true, "darwin"))).toBe(path.join("/bin", "telo-desktop-host"));
  });

  it("is nothing for an application that is not one", () => {
    expect(packagedHelperPath(app(false, "linux"))).toBeUndefined();
  });
});
