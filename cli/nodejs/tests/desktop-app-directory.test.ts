import { describe, expect, it } from "vitest";

import { desktopHostDirectory, stateDirectory, userAppDirectory } from "../src/desktop/desktop-app-directory.js";

describe("the per-user application directory", () => {
  it("follows each platform's convention, by identifier", () => {
    const id = "run.telo.examples.hello";
    expect(userAppDirectory(id, { platform: "linux", env: { XDG_DATA_HOME: "/data" }, home: "/home/me" })).toBe(`/data/${id}`);
    expect(userAppDirectory(id, { platform: "linux", env: {}, home: "/home/me" })).toBe(`/home/me/.local/share/${id}`);
    expect(userAppDirectory(id, { platform: "linux", env: { XDG_DATA_HOME: "relative" }, home: "/home/me" })).toBe(
      `/home/me/.local/share/${id}`,
    );
    expect(userAppDirectory(id, { platform: "darwin", env: {}, home: "/Users/me" })).toBe(
      `/Users/me/Library/Application Support/${id}`,
    );
    expect(userAppDirectory(id, { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } })).toBe(
      `C:\\Users\\me\\AppData\\Local\\${id}`,
    );
  });

  it("is null where the platform's anchor is unset, and names desktop-host/ and state/ beneath it", () => {
    expect(userAppDirectory("a.b", { platform: "win32", env: {} })).toBeNull();
    expect(desktopHostDirectory("/app")).toMatch(/[\\/]app[\\/]desktop-host$/);
    expect(stateDirectory("/app")).toMatch(/[\\/]app[\\/]state$/);
  });
});
