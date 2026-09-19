import type { LoadedGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import {
  commandExists,
  CONTROLLER_TOOL_MISSING,
  probeControllerTools,
} from "../src/controller-tool-probe.js";

/**
 * Check may probe for the programs a manifest's controllers will need; boot may
 * not. What this pins down is which kinds are worth asking about at all, and
 * that an unavailable answer never invents a warning about the author's
 * manifest.
 */

/** The slice of a loaded graph this reads: one module, its kind docs, and the
 *  import edge that pulled it in. */
function graphWith(controllers: string[][]): LoadedGraph {
  const source = "file:///modules/example/telo.yaml";
  const owner = {
    source,
    requestedUrl: "oci://ghcr.io/telorun/example@1.0.0",
    manifests: [
      { kind: "Telo.Library", metadata: { name: "Example" } },
      ...controllers.map((candidates, index) => ({
        kind: "Telo.Definition",
        metadata: { name: `Kind${index}` },
        controllers: candidates,
      })),
    ],
    positions: [],
  };
  return {
    rootSource: source,
    entry: { owner, partials: [] },
    modules: new Map([[source, { owner, partials: [] }]]),
    importEdges: new Map(),
    overrides: new Map(),
  } as unknown as LoadedGraph;
}

/** Which tools exist is injected, never spawned: a test that asks the machine
 *  answers differently on a machine with npm installed, and differently again
 *  where spawning is denied — where the probe correctly reports every tool
 *  present, since a question it cannot answer must not invent a warning. */
const NOTHING_INSTALLED = { env: {}, exists: async () => false };
const EVERYTHING_INSTALLED = { env: {}, exists: async () => true };

describe("probeControllerTools", () => {
  it("says nothing about a bundled controller — it launches no process either", async () => {
    const diagnostics = await probeControllerTools(
      graphWith([["pkg:telo/local/js?path=./nodejs/example.mjs#kind"]]),
      NOTHING_INSTALLED,
    );
    expect(diagnostics).toEqual([]);
  });

  it("says nothing when a kind offers a bundled candidate beside a Rust one", async () => {
    // `std/console`'s shape. The kernel takes the bundled candidate, so warning
    // about cargo would be a warning about a path never taken.
    const diagnostics = await probeControllerTools(
      graphWith([
        ["pkg:cargo/telo-console?local_path=./rust#writeLine", "pkg:telo/local/js?path=./x.mjs#w"],
      ]),
      NOTHING_INSTALLED,
    );
    expect(diagnostics).toEqual([]);
  });

  it("warns, never errors, when every candidate needs a tool this machine lacks", async () => {
    const diagnostics = await probeControllerTools(
      graphWith([["pkg:npm/@telorun/example@1.0.0?local_path=./nodejs#kind"]]),
      NOTHING_INSTALLED,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe(CONTROLLER_TOOL_MISSING);
    // Warning: the machine running check is often not the one that runs the app.
    expect(diagnostics[0]!.severity).toBe(2);
    expect(diagnostics[0]!.message).toContain("npm");
    expect(diagnostics[0]!.message).toContain("oci://ghcr.io/telorun/example@1.0.0");
  });

  it("reports one line per module, not per kind", async () => {
    const npm = ["pkg:npm/@telorun/example@1.0.0?local_path=./nodejs#kind"];
    const diagnostics = await probeControllerTools(graphWith([npm, npm, npm]), NOTHING_INSTALLED);
    expect(diagnostics).toHaveLength(1);
  });

  it("says nothing when the tool is present", async () => {
    const diagnostics = await probeControllerTools(
      graphWith([["pkg:npm/@telorun/example@1.0.0#kind"]]),
      EVERYTHING_INSTALLED,
    );
    expect(diagnostics).toEqual([]);
  });

  it("asks once per tool, however many kinds name it", async () => {
    const asked: string[] = [];
    const npm = ["pkg:npm/@telorun/example@1.0.0#kind"];
    await probeControllerTools(graphWith([npm, npm, npm]), {
      env: {},
      exists: async (tool) => {
        asked.push(tool);
        return false;
      },
    });
    expect(asked).toEqual(["npm"]);
  });

  it("layers a partial env over the ambient one rather than replacing it", async () => {
    // The `env` argument says which package manager to look for; handing it to
    // the spawn whole leaves it with no PATH, under which every tool on earth
    // is missing. Both calls ask the same question, so they must agree — on a
    // machine that can spawn and on one where spawning is denied alike, which
    // is what keeps this from asserting a property of the runner.
    const ambient = await commandExists("node", process.env);
    const partial = await commandExists("node", { TELO_PKG_MANAGER: "irrelevant" });
    expect(partial).toBe(ambient);
  });
});
