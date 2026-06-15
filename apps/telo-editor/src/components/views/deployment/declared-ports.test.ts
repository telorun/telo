import { describe, expect, it } from "vitest";
import { extractDeclaredPorts, resolveDeclaredPorts } from "./declared-ports";

describe("extractDeclaredPorts", () => {
  it("projects the ports: block, defaulting protocol to tcp", () => {
    const rows = extractDeclaredPorts({
      kind: "Application",
      ports: {
        http: { env: "PORT", default: 8080 },
        metrics: { env: "METRICS_PORT", protocol: "udp" },
      },
    });
    expect(rows).toEqual([
      { name: "http", envVar: "PORT", protocol: "tcp", defaultText: "8080" },
      { name: "metrics", envVar: "METRICS_PORT", protocol: "udp", defaultText: undefined },
    ]);
  });

  it("returns an empty list for Library manifests", () => {
    expect(
      extractDeclaredPorts({ kind: "Library", ports: { http: { env: "PORT" } } }),
    ).toEqual([]);
  });

  it("skips entries with no env: binding", () => {
    const rows = extractDeclaredPorts({
      kind: "Application",
      ports: { legacy: { default: 80 }, ok: { env: "OK" } },
    });
    expect(rows.map((r) => r.name)).toEqual(["ok"]);
  });

  it("returns an empty list when no ports: block is declared", () => {
    expect(extractDeclaredPorts({ kind: "Application" })).toEqual([]);
  });
});

describe("resolveDeclaredPorts", () => {
  const manifest = {
    kind: "Application" as const,
    ports: {
      http: { env: "PORT", default: 8080 },
      metrics: { env: "METRICS_PORT", protocol: "udp" as const },
    },
  };

  it("uses the supplied env value over the default", () => {
    expect(resolveDeclaredPorts(manifest, { PORT: "9090" })).toEqual([
      { port: 9090, protocol: "tcp" },
    ]);
  });

  it("falls back to the declared default when no value is supplied", () => {
    expect(resolveDeclaredPorts(manifest, {})).toEqual([{ port: 8080, protocol: "tcp" }]);
  });

  it("drops ports with no value and no default", () => {
    expect(resolveDeclaredPorts(manifest, {})).not.toContainEqual(
      expect.objectContaining({ protocol: "udp" }),
    );
  });

  it("drops out-of-range or non-integer values", () => {
    expect(resolveDeclaredPorts(manifest, { PORT: "70000", METRICS_PORT: "abc" })).toEqual([]);
  });

  it("returns nothing for a Library manifest", () => {
    expect(resolveDeclaredPorts({ kind: "Library", ports: manifest.ports }, {})).toEqual([]);
  });
});
