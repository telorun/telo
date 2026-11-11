import { describe, expect, it } from "vitest";

import { assertDesktopAvailable } from "../src/desktop/desktop-availability.js";
import { DesktopHostUnavailable } from "../src/desktop/desktop-host-unavailable.js";

describe("desktop host availability", () => {
  it("refuses a Linux session with no display", async () => {
    const refused = assertDesktopAvailable({ platform: "linux", env: {} });
    await expect(refused).rejects.toBeInstanceOf(DesktopHostUnavailable);
    await expect(refused).rejects.toMatchObject({
      code: "ERR_DESKTOP_HOST_UNAVAILABLE",
      message: "cannot start the desktop host: no display (neither WAYLAND_DISPLAY nor DISPLAY is set)",
    });
  });

  it("accepts either display variable", async () => {
    await assertDesktopAvailable({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });
    await assertDesktopAvailable({ platform: "linux", env: { DISPLAY: ":0" } });
  });

  it("refuses macOS older than 14, naming the version, and accepts 14", async () => {
    await expect(assertDesktopAvailable({ platform: "darwin", macosVersion: async () => "13.6" })).rejects.toMatchObject({
      message: "cannot start the desktop host: macOS 14 or later is required (this is macOS 13.6)",
    });
    await assertDesktopAvailable({ platform: "darwin", macosVersion: async () => "14.0" });
    await assertDesktopAvailable({ platform: "darwin", macosVersion: async () => "26.1" });
  });

  it("asks nothing of Windows", async () => {
    await assertDesktopAvailable({ platform: "win32", env: {} });
  });
});
