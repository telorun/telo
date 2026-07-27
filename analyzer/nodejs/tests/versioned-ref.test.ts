import { describe, expect, it } from "vitest";

import { parseVersionedRef, withRefVersion } from "../src/sources/versioned-ref.js";

describe("parseVersionedRef", () => {
  it("splits a registry ref", () => {
    expect(parseVersionedRef("std/console@0.9.0")).toEqual({
      baseRef: "std/console",
      version: "0.9.0",
      integrity: undefined,
    });
  });

  it("splits an OCI ref and keeps the scheme on the base", () => {
    expect(parseVersionedRef("oci://ghcr.io/telorun/timer@0.3.0")).toEqual({
      baseRef: "oci://ghcr.io/telorun/timer",
      version: "0.3.0",
      integrity: undefined,
    });
  });

  it("carries the inline pin and keeps it off the base ref", () => {
    expect(parseVersionedRef("oci://ghcr.io/telorun/timer@0.3.0#sha256-abc_123")).toEqual({
      baseRef: "oci://ghcr.io/telorun/timer",
      version: "0.3.0",
      integrity: "sha256-abc_123",
    });
  });

  it("returns a digest reference raw — the caller's semver check skips it", () => {
    expect(parseVersionedRef("oci://ghcr.io/telorun/timer@sha256:deadbeef")?.version).toBe(
      "sha256:deadbeef",
    );
  });

  it("keeps a multi-segment OCI repo on the base ref", () => {
    expect(parseVersionedRef("oci://ghcr.io/a/b/c@1.0.0")?.baseRef).toBe("oci://ghcr.io/a/b/c");
  });

  it("returns null when no version is named", () => {
    // An implicit `latest` is not an upgradeable pin.
    expect(parseVersionedRef("oci://ghcr.io/telorun/timer")).toBeNull();
    expect(parseVersionedRef("../lib")).toBeNull();
    expect(parseVersionedRef("./lib@1.0.0")).toBeNull();
    expect(parseVersionedRef("/abs/lib")).toBeNull();
    expect(parseVersionedRef("https://example.com/telo.yaml")).toBeNull();
    expect(parseVersionedRef("std/console")).toBeNull();
    expect(parseVersionedRef("std/console@")).toBeNull();
    expect(parseVersionedRef("oci://@1.0.0")).toBeNull();
  });
});

describe("withRefVersion", () => {
  it("re-points a registry ref", () => {
    expect(withRefVersion("std/console@0.9.0", "0.10.0")).toBe("std/console@0.10.0");
  });

  it("re-points an OCI ref and drops the stale pin", () => {
    expect(withRefVersion("oci://ghcr.io/telorun/timer@0.3.0#sha256-abc", "0.4.0")).toBe(
      "oci://ghcr.io/telorun/timer@0.4.0",
    );
  });

  it("replaces a digest reference", () => {
    expect(withRefVersion("oci://ghcr.io/telorun/timer@sha256:deadbeef", "0.4.0")).toBe(
      "oci://ghcr.io/telorun/timer@0.4.0",
    );
  });

  it("appends a version to an untagged OCI ref", () => {
    expect(withRefVersion("oci://ghcr.io/telorun/timer", "0.4.0")).toBe(
      "oci://ghcr.io/telorun/timer@0.4.0",
    );
  });

  it("throws rather than fabricating a version on a ref that has no version segment", () => {
    // `../lib@0.4.0` would be a ref nothing can resolve.
    expect(() => withRefVersion("../lib", "0.4.0")).toThrow(/only registry .* and oci:\/\/ refs/);
    expect(() => withRefVersion("https://example.com/telo.yaml", "0.4.0")).toThrow();
    expect(() => withRefVersion("std/console", "0.4.0")).toThrow();
    expect(() => withRefVersion("oci://ghcr.io", "0.4.0")).toThrow();
  });
});
