import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { buildCelEnvironment, buildTypedCelEnvironment } from "../src/cel-environment.js";
import {
  brandOfSchema,
  celTypeSatisfiesJsonSchema,
  jsonSchemaToCelType,
} from "../src/schema-compat.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

describe("value brands (x-telo-type)", () => {
  it("jsonSchemaToCelType returns the brand when present", () => {
    expect(jsonSchemaToCelType({ type: "integer", "x-telo-type": "Telo.TcpPort" })).toBe("Telo.TcpPort");
    expect(jsonSchemaToCelType({ type: "integer" })).toBe("int");
    // Unrecognized brand falls back to the base type, not the brand string.
    expect(jsonSchemaToCelType({ type: "integer", "x-telo-type": "Bogus" })).toBe("int");
  });

  it("brandOfSchema reads only recognized brands", () => {
    expect(brandOfSchema({ "x-telo-type": "Telo.TcpPort" })).toBe("Telo.TcpPort");
    expect(brandOfSchema({ "x-telo-type": "Bogus" })).toBeUndefined();
    expect(brandOfSchema({ type: "integer" })).toBeUndefined();
  });

  describe("celTypeSatisfiesJsonSchema", () => {
    const tcpField = { type: "integer", "x-telo-type": "Telo.TcpPort" };
    const plainIntField = { type: "integer" };

    it("accepts a matching brand", () => {
      expect(celTypeSatisfiesJsonSchema("Telo.TcpPort", tcpField)).toBe(true);
    });

    it("rejects a conflicting brand", () => {
      expect(celTypeSatisfiesJsonSchema("Telo.UdpPort", tcpField)).toBe(false);
    });

    it("accepts a branded value into an unbranded field of the base type", () => {
      expect(celTypeSatisfiesJsonSchema("Telo.TcpPort", plainIntField)).toBe(true);
    });

    it("accepts a plain base value into a branded field (gradual typing)", () => {
      expect(celTypeSatisfiesJsonSchema("int", tcpField)).toBe(true);
    });

    it("still rejects a base-type mismatch on a branded field", () => {
      expect(celTypeSatisfiesJsonSchema("string", tcpField)).toBe(false);
    });
  });
});

describe("ports namespace typing", () => {
  function appWithPorts(): ResourceManifest {
    return {
      kind: "Telo.Application",
      metadata: { name: "app" },
      ports: {
        http: { env: "PORT", protocol: "tcp" },
        dns: { env: "DNS_PORT", protocol: "udp" },
        legacy: { env: "LEGACY" }, // protocol defaults to tcp
      },
    } as unknown as ResourceManifest;
  }

  it("types ports.<name> by the entry's protocol brand", () => {
    const env = buildTypedCelEnvironment(buildCelEnvironment(), appWithPorts());
    expect(env.check("ports.http").type).toBe("Telo.TcpPort");
    expect(env.check("ports.dns").type).toBe("Telo.UdpPort");
    expect(env.check("ports.legacy").type).toBe("Telo.TcpPort");
  });

  it("flags an unknown port name", () => {
    const env = buildTypedCelEnvironment(buildCelEnvironment(), appWithPorts());
    expect(env.check("ports.typo").valid).toBe(false);
  });
});

describe("cross-doc port wiring", () => {
  /** A Service definition whose `port` field is branded TcpPort. */
  const serverDef: ResourceManifest = {
    kind: "Telo.Definition",
    metadata: { name: "Server", module: "srv" },
    capability: "Telo.Service",
    schema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          "x-telo-eval": "compile",
          "x-telo-type": "Telo.TcpPort",
          minimum: 1,
          maximum: 65535,
        },
      },
    },
  } as unknown as ResourceManifest;

  function analyzeWith(port: unknown) {
    const manifests = [
      {
        kind: "Telo.Application",
        metadata: { name: "app", source: "telo.yaml" },
        ports: {
          http: { env: "PORT", protocol: "tcp" },
          dns: { env: "DNS_PORT", protocol: "udp" },
        },
      },
      serverDef,
      {
        kind: "srv.Server",
        metadata: { name: "main", source: "telo.yaml" },
        port,
      },
    ] as unknown as ResourceManifest[];
    return new StaticAnalyzer()
      .analyze(withSyntheticPositions(manifests))
      .filter((d) => d.code === "CEL_TYPE_ERROR");
  }

  it("accepts a TcpPort wired into a TcpPort field", () => {
    expect(analyzeWith("${{ ports.http }}")).toHaveLength(0);
  });

  it("rejects a UdpPort wired into a TcpPort field", () => {
    const diags = analyzeWith("${{ ports.dns }}");
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some((d) => d.message.includes("Telo.UdpPort") && d.message.includes("Telo.TcpPort"))).toBe(
      true,
    );
  });

  // `!cel`-tagged values must behave identically to the `${{ … }}` string form.
  it("rejects a UdpPort via a !cel-tagged value", () => {
    const diags = analyzeWith(makeTaggedSentinel("cel", "ports.dns"));
    expect(diags.some((d) => d.message.includes("Telo.UdpPort") && d.message.includes("Telo.TcpPort"))).toBe(
      true,
    );
  });

  it("accepts a TcpPort via a !cel-tagged value", () => {
    expect(analyzeWith(makeTaggedSentinel("cel", "ports.http"))).toHaveLength(0);
  });
});
