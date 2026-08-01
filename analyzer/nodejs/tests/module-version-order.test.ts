import { describe, expect, it } from "vitest";

import {
  compareModuleVersions,
  isNewerModuleVersion,
  isSameModuleVersion,
  newestModuleVersion,
} from "../src/module-version-order.js";

describe("compareModuleVersions", () => {
  it("orders by numeric precedence, not lexically", () => {
    expect(compareModuleVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareModuleVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareModuleVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("tolerates a leading v on either side", () => {
    expect(compareModuleVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareModuleVersions("1.3.0", "v1.2.3")).toBeGreaterThan(0);
  });

  it("ranks a release above its prereleases", () => {
    expect(compareModuleVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareModuleVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBeLessThan(0);
    expect(compareModuleVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  });

  it("returns null for a tag that is not a three-part numeric core", () => {
    expect(compareModuleVersions("sha256:deadbeef", "1.0.0")).toBeNull();
    expect(compareModuleVersions("latest", "1.0.0")).toBeNull();
    expect(compareModuleVersions("1.2", "1.2.0")).toBeNull();
  });
});

describe("isNewerModuleVersion", () => {
  it("is true only for a strictly newer candidate", () => {
    expect(isNewerModuleVersion("0.4.0", "0.3.0")).toBe(true);
    expect(isNewerModuleVersion("0.3.0", "0.3.0")).toBe(false);
  });

  it("is true for a release over the prerelease currently pinned", () => {
    expect(isNewerModuleVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
  });

  it("is false when the pin is ahead of the candidate", () => {
    // A lagging version index must not turn an upgrade into a downgrade.
    expect(isNewerModuleVersion("0.3.0", "0.4.0")).toBe(false);
  });

  it("is false for a v-prefixed pin naming the same version", () => {
    expect(isNewerModuleVersion("1.2.3", "v1.2.3")).toBe(false);
  });

  it("is false when either side is unparseable", () => {
    expect(isNewerModuleVersion("1.0.0", "sha256:deadbeef")).toBe(false);
    expect(isNewerModuleVersion("latest", "1.0.0")).toBe(false);
  });
});

describe("isSameModuleVersion", () => {
  it("matches across a v prefix and for identical unparseable tags", () => {
    expect(isSameModuleVersion("v1.2.3", "1.2.3")).toBe(true);
    expect(isSameModuleVersion("sha256:abc", "sha256:abc")).toBe(true);
    expect(isSameModuleVersion("1.2.3", "1.2.4")).toBe(false);
  });
});

describe("newestModuleVersion", () => {
  it("is independent of the list's own order", () => {
    expect(newestModuleVersion(["0.9.0", "1.0.0", "0.8.0"])).toBe("1.0.0");
    expect(newestModuleVersion(["1.0.0", "0.9.0"])).toBe("1.0.0");
  });

  it("excludes prereleases by default and includes them on request", () => {
    expect(newestModuleVersion(["1.1.0-rc.1", "1.0.0"])).toBe("1.0.0");
    expect(newestModuleVersion(["1.1.0-rc.1", "1.0.0"], { includePrerelease: true })).toBe(
      "1.1.0-rc.1",
    );
  });

  it("still finds the release that supersedes a prerelease", () => {
    expect(newestModuleVersion(["1.0.0-rc.1", "1.0.0"])).toBe("1.0.0");
  });

  it("drops unparseable tags instead of ordering them", () => {
    // A moving tag at the head of the list must not become the running maximum
    // and silence every comparable candidate after it.
    expect(newestModuleVersion(["latest", "0.9.0", "1.0.0"])).toBe("1.0.0");
    expect(newestModuleVersion(["sha256:deadbeef"])).toBeUndefined();
  });

  it("preserves the tag as written", () => {
    expect(newestModuleVersion(["v1.2.3", "1.0.0"])).toBe("v1.2.3");
  });

  it("is undefined for an empty or wholly ineligible list", () => {
    expect(newestModuleVersion([])).toBeUndefined();
    expect(newestModuleVersion(["1.0.0-rc.1"])).toBeUndefined();
  });
});
