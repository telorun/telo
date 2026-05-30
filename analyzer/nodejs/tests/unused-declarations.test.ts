import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const def: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Thing", module: "t" },
  capability: "Telo.Service",
  schema: { type: "object", properties: { a: {}, b: {} } },
} as unknown as ResourceManifest;

/** Analyze [Application(+appExtra), Def, Resource(+fields)] and return the
 *  UNUSED_DECLARATION diagnostics. */
function unusedFor(appExtra: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  const manifests = [
    { kind: "Telo.Application", metadata: { name: "app", source: "telo.yaml" }, ...appExtra },
    def,
    { kind: "t.Thing", metadata: { name: "r", source: "telo.yaml" }, ...fields },
  ] as unknown as ResourceManifest[];
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "UNUSED_DECLARATION");
}

describe("unused declaration warnings", () => {
  it("warns about an unreferenced port", () => {
    const diags = unusedFor({ ports: { http: { env: "PORT", default: 8080 } } });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("ports.http");
  });

  it("warns about an unreferenced variable and secret (same generic path)", () => {
    const diags = unusedFor({
      variables: { v: { env: "V", type: "string" } },
      secrets: { s: { env: "S", type: "string" } },
    });
    const paths = diags.map((d) => (d.data as { path?: string }).path).sort();
    expect(paths).toEqual(["secrets.s", "variables.v"]);
  });

  it("does not warn when referenced via a ${{ }} string", () => {
    expect(unusedFor({ ports: { http: { env: "PORT" } } }, { a: "${{ ports.http }}" })).toHaveLength(
      0,
    );
  });

  it("does not warn when referenced via a !cel tag", () => {
    expect(
      unusedFor({ variables: { v: { env: "V", type: "string" } } }, {
        a: makeTaggedSentinel("cel", "variables.v"),
      }),
    ).toHaveLength(0);
  });

  it("suppresses the whole namespace on whole-namespace access", () => {
    // `keys(ports)` touches the `ports` root without a static member, so neither
    // declared port can be attributed — suppress rather than false-positive.
    const diags = unusedFor(
      { ports: { http: { env: "PORT" }, dns: { env: "DNS", protocol: "udp" } } },
      { a: "${{ keys(ports) }}" },
    );
    expect(diags).toHaveLength(0);
  });

  it("suppresses the whole namespace on dynamic indexed access", () => {
    // `ports[a]` extracts as ["ports", "[*]"] — the index segment is not a real
    // declared name, so it must suppress, not record "[*]" as used.
    const diags = unusedFor(
      { ports: { http: { env: "PORT" }, dns: { env: "DNS", protocol: "udp" } } },
      { a: '${{ ports["http"] }}' },
    );
    expect(diags).toHaveLength(0);
  });

  it("does not flag Telo.Library variables/secrets (public contract)", () => {
    const manifests = [
      {
        kind: "Telo.Library",
        metadata: { name: "lib", source: "telo.yaml" },
        secrets: { token: { type: "string" } },
        variables: { region: { type: "string" } },
      },
    ] as unknown as ResourceManifest[];
    const diags = new StaticAnalyzer()
      .analyze(withSyntheticPositions(manifests))
      .filter((d) => d.code === "UNUSED_DECLARATION");
    expect(diags).toHaveLength(0);
  });
});
