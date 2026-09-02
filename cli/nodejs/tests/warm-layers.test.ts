import type { LoadedGraph } from "@telorun/analyzer";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { warmModuleLayers } from "../src/bundle/warm-layers.js";

/**
 * `warmModuleLayers` returns the artifact handles it builds, keyed by module
 * source, so the controller pre-install pass can resolve `pkg:telo` candidates
 * of published modules against their artifact layers — without the handle every
 * bundled candidate is env-missing and the job fails on a module `telo run`
 * loads fine.
 */

const BLOB = "sha256:" + "a".repeat(64);
const INTEGRITY = "sha256-" + "A".repeat(43);

// Pinned to an unreachable local port so the materialization attempt fails
// instantly (connection refused) instead of touching the network — the warm is
// best-effort, and the artifact handle must survive the failure.
const OCI_REF = "oci://127.0.0.1:1/acme/mod@1.0.0";
const OCI_SOURCE = `${OCI_REF}/telo.yaml`;

const OCI_OWNER_TEXT = [
  "kind: Telo.Library",
  "metadata:",
  "  name: mod",
  "  version: 1.0.0",
  "layers:",
  "  - role: controller",
  "    selector:",
  "      format: js",
  `    blob: ${BLOB}`,
  `    integrity: ${INTEGRITY}`,
  "",
].join("\n");

describe("warmModuleLayers", () => {
  let entryDir: string;

  beforeAll(async () => {
    entryDir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-warm-"));
  });

  afterAll(async () => {
    await fs.rm(entryDir, { recursive: true, force: true });
  });

  it("returns the artifact of a layered module even when its warm fails, and none for a payload-less one", async () => {
    const localSource = path.join(entryDir, "local-lib", "telo.yaml");
    // `partials` and `importEdges` are not padding: a LoadedModule always
    // carries a partials list (empty when it declares no `include:`) and a graph
    // always carries its import edges, so a stub omitting them is describing a
    // graph the loader cannot produce. The cast is what let it compile —
    // `warmModuleLayers` walks both through `buildSiblingLibraries`.
    const graph = {
      modules: new Map([
        [
          OCI_REF,
          {
            owner: { source: OCI_SOURCE, requestedUrl: OCI_REF, text: OCI_OWNER_TEXT },
            partials: [],
          },
        ],
        [
          localSource,
          {
            owner: {
              source: localSource,
              requestedUrl: "../local-lib",
              text: "kind: Telo.Library\nmetadata:\n  name: local-lib\n  version: 1.0.0\n",
            },
            partials: [],
          },
        ],
      ]),
      importEdges: new Map(),
    } as unknown as LoadedGraph;

    const warnings: string[] = [];
    const warmed = await warmModuleLayers(
      graph,
      entryDir,
      path.join(entryDir, ".telo", "manifests"),
      { os: "linux", arch: "amd64" },
      (msg) => warnings.push(msg),
    );

    // The fetch failed (refused), so nothing materialized and the warn fired —
    // but the handle is still returned for the pre-install pass to use.
    expect(warmed.materialized).toBe(0);
    expect(warnings.some((w) => w.includes(OCI_REF))).toBe(true);
    expect(warmed.artifacts.has(OCI_SOURCE)).toBe(true);
    // A module with no `layers:` index has no payload to address.
    expect(warmed.artifacts.has(localSource)).toBe(false);
  });
});
