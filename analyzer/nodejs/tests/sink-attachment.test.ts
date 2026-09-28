import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * `SINK_UNATTACHED`: the runtime attaches only the sinks the root Application
 * lists, so a sink nothing references receives nothing.
 */
function unattached(tracing: unknown) {
  return new StaticAnalyzer()
    .analyze(
      withSyntheticPositions([
        {
          kind: "Telo.Application",
          metadata: { name: "App", module: "App" },
          ...(tracing === undefined ? {} : { tracing }),
        },
        { kind: "Telo.LogTraceSink", metadata: { name: "traces", module: "App" } },
      ] as unknown as ResourceManifest[]),
    )
    .filter((d) => d.code === "SINK_UNATTACHED")
    .map((d) => (d.data as { resource: { name: string } }).resource.name);
}

describe("SINK_UNATTACHED", () => {
  it("warns at a sink no list names", () => {
    expect(unattached(undefined)).toEqual(["traces"]);
  });

  it("is silent for a listed sink, in either entry form", () => {
    expect(unattached({ sinks: [{ kind: "Telo.LogTraceSink", name: "traces" }] })).toEqual([]);
    expect(
      unattached({ sinks: [{ sink: { kind: "Telo.LogTraceSink", name: "traces" }, when: false }] }),
    ).toEqual([]);
  });
});
