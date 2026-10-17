import { describe, expect, it } from "vitest";
import {
  hostnameClaim,
  hostnameMatcher,
  hostnameMatcherOfOrigin,
  isIpLiteral,
  normalizeRequestHost,
  sameHostnameMatcher,
} from "../src/hostname.js";

describe("a request's host", () => {
  it.each([
    ["Shop.Example:8080", "shop.example"],
    ["shop.example.", "shop.example"],
    ["[::1]:8080", "[::1]"],
    ["127.0.0.1:80", "127.0.0.1"],
  ])("normalizes %s to %s", (raw, normalized) => {
    expect(normalizeRequestHost(raw)).toBe(normalized);
  });

  it("tells an IP literal from a name", () => {
    expect(isIpLiteral("10.0.0.7")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("shop.example")).toBe(false);
  });
});

describe("a hostname matcher", () => {
  const label = hostnameMatcherOfOrigin("https://*.tenants.shop.example")!;
  const prefix = hostnameMatcherOfOrigin("http://*-tenants.shop.example:8080")!;
  const exact = hostnameMatcher("admin.shop.example")!;

  it("matches one or more whole labels for '*.'", () => {
    expect(hostnameClaim(label, "acme.tenants.shop.example")).toBe(".tenants.shop.example".length);
    expect(hostnameClaim(label, "a.b.tenants.shop.example")).toBeDefined();
    expect(hostnameClaim(label, "tenants.shop.example")).toBeUndefined();
  });

  it("matches inside the first label only for '*<text>.'", () => {
    expect(hostnameClaim(prefix, "acme-tenants.shop.example")).toBe("-tenants.shop.example".length);
    expect(hostnameClaim(prefix, "a.b-tenants.shop.example")).toBeUndefined();
    expect(hostnameClaim(prefix, "-tenants.shop.example")).toBeUndefined();
  });

  it("claims an exact host above any pattern", () => {
    expect(hostnameClaim(exact, "admin.shop.example")).toBe(Number.POSITIVE_INFINITY);
    expect(hostnameClaim(exact, "shop.example")).toBeUndefined();
  });

  it("is the same matcher only for the same form and suffix", () => {
    expect(sameHostnameMatcher(label, hostnameMatcher("*.TENANTS.shop.example")!)).toBe(true);
    expect(sameHostnameMatcher(label, prefix)).toBe(false);
  });
});

/** The one table both readers of a host pattern are held to — this one, and the
 *  analyzer's `parseHostPattern` (its `host-pattern-vectors.test.ts` carries the
 *  same rows). A change to one reader changes both tables. */
const VECTORS: Array<[string, { form: "label" | "prefix"; suffix: string } | null]> = [
  ["*.a.example", { form: "label", suffix: ".a.example" }],
  ["*.A.Example.", { form: "label", suffix: ".a.example" }],
  ["*-a.example", { form: "prefix", suffix: "-a.example" }],
  ["*x-a.example", { form: "prefix", suffix: "x-a.example" }],
  ["*.", null],
  ["*", null],
  ["*-a", null],
  ["*-a.", null],
];

describe("a host pattern", () => {
  it.each(VECTORS)("%s reads as %j", (pattern, expected) => {
    const matcher = hostnameMatcher(pattern);
    expect(matcher && matcher.kind === "pattern" ? { form: matcher.form, suffix: matcher.suffix } : null).toEqual(
      expected,
    );
  });
});
