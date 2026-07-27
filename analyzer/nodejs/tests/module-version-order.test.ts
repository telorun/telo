import { describe, expect, it } from "vitest";

import {
  compareModuleVersions,
  isNewerModuleVersion,
  isSameModuleVersion,
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
