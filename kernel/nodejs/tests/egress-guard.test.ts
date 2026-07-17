import { afterEach, describe, expect, it } from "vitest";

import {
  EgressDeniedError,
  assertPublicEgress,
  isPrivateAddress,
} from "../src/transports/egress-guard.js";

afterEach(() => {
  delete process.env.TELO_EGRESS;
});

describe("isPrivateAddress", () => {
  it("classifies IPv4 ranges", () => {
    for (const addr of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
    ]) {
      expect(isPrivateAddress(addr), addr).toBe(true);
    }
    for (const addr of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "203.0.113.7"]) {
      expect(isPrivateAddress(addr), addr).toBe(false);
    }
  });

  it("classifies IPv6 ranges including mapped IPv4", () => {
    for (const addr of ["::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(addr), addr).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("::ffff:1.1.1.1")).toBe(false);
  });
});

describe("assertPublicEgress", () => {
  it("is a no-op when the policy is not active", async () => {
    await expect(assertPublicEgress("127.0.0.1")).resolves.toBeUndefined();
    await expect(assertPublicEgress("http://169.254.169.254/latest")).resolves.toBeUndefined();
  });

  it("denies private IP literals under public-only", async () => {
    process.env.TELO_EGRESS = "public-only";
    await expect(assertPublicEgress("127.0.0.1")).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(assertPublicEgress("10.0.0.5:5000")).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(assertPublicEgress("http://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(
      EgressDeniedError,
    );
    await expect(assertPublicEgress("https://[::1]:8080/v2/")).rejects.toBeInstanceOf(
      EgressDeniedError,
    );
  });

  it("allows public IP literals under public-only", async () => {
    process.env.TELO_EGRESS = "public-only";
    await expect(assertPublicEgress("1.1.1.1")).resolves.toBeUndefined();
    await expect(assertPublicEgress("https://203.0.113.7/v2/")).resolves.toBeUndefined();
  });

  it("denies hostnames that resolve to loopback", async () => {
    process.env.TELO_EGRESS = "public-only";
    await expect(assertPublicEgress("localhost")).rejects.toBeInstanceOf(EgressDeniedError);
  });
});
