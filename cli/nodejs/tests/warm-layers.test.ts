import type { LoadedGraph } from "@telorun/analyzer";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  TransportRegistry,
  computeFilesIntegrity,
  hostPlatformTarget,
  type PayloadFile,
} from "@telorun/kernel";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeGaps, parsePlatformTarget, warmModuleLayers } from "../src/bundle/warm-layers.js";

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

    const warmed = await warmModuleLayers(
      graph,
      entryDir,
      path.join(entryDir, ".telo", "manifests"),
      { os: "linux", arch: "amd64" },
    );

    // The fetch failed (refused), so nothing materialized and the gap is
    // reported — but the handle is still returned for the pre-install pass to
    // use.
    expect(warmed.materialized).toBe(0);
    expect(warmed.gaps.map((gap) => gap.cause)).toEqual(["fetch"]);
    expect(warmed.gaps[0].module).toBe(OCI_REF);
    expect(warmed.artifacts.has(OCI_SOURCE)).toBe(true);
    // A module with no `layers:` index has no payload to address.
    expect(warmed.artifacts.has(localSource)).toBe(false);
  });

  describe("abi-constrained layers", () => {
    // Fetches are stubbed, so the ref needs no reachable host — and carries no
    // port, whose `:` is not a legal character in a Windows cache directory name.
    const OCI_REF = "oci://registry.test/acme/mod@1.0.0";
    const OCI_SOURCE = `${OCI_REF}/telo.yaml`;
    // One file per layer, served by blob digest, so a test sees exactly which
    // layers the warm fetched. Native and code roles are warmed and reported by
    // one rule.
    const NATIVE_LAYERS = [
      { role: "native", selector: "{ format: node, os: linux, abi: node-137 }", blob: "c", file: "linux-137.node" },
      { role: "controller", selector: "{ format: js, os: linux, abi: node-141 }", blob: "d", file: "linux-141.mjs" },
      { role: "native", selector: "{ format: node, os: darwin, abi: node-137 }", blob: "e", file: "darwin-137.node" },
      // A Rust kernel's controller: a Node install neither reports nor warms it.
      { role: "controller", selector: "{ format: dylib, os: linux, abi: telo-3 }", blob: "f", file: "libx.so" },
    ].map((l) => ({ ...l, blob: `sha256:${l.blob.repeat(64)}` }));
    const payload = (name: string): PayloadFile[] => [{ name, content: Buffer.from(name) }];

    let fetched: string[];

    beforeEach(() => {
      fetched = [];
      vi.spyOn(TransportRegistry.prototype, "fetchLayer").mockImplementation(async (_ref, blob) => {
        fetched.push(blob);
        const layer = NATIVE_LAYERS.find((l) => l.blob === blob);
        if (!layer) throw new Error(`unexpected blob ${blob}`);
        return payload(layer.file);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const warm = async (target: { os: string; arch: string; abi?: string }) => {
      const layers = await Promise.all(
        NATIVE_LAYERS.map(async (l) => [
          `  - role: ${l.role}`,
          `    selector: ${l.selector}`,
          `    blob: ${l.blob}`,
          `    integrity: ${await computeFilesIntegrity(payload(l.file))}`,
        ]),
      );
      const text = ["kind: Telo.Library", "metadata:", "  name: native", "  version: 1.0.0", "layers:"]
        .concat(...layers)
        .join("\n");
      const graph = {
        modules: new Map([
          [OCI_REF, { owner: { source: OCI_SOURCE, requestedUrl: OCI_REF, text }, partials: [] }],
        ]),
        importEdges: new Map(),
      } as unknown as LoadedGraph;
      const moduleCache = await fs.mkdtemp(path.join(entryDir, "abi-"));
      const warmed = await warmModuleLayers(
        graph,
        moduleCache,
        path.join(moduleCache, "manifests"),
        target,
      );
      return { warmed };
    };

    it("warms none and reports each one it skips when the target names no abi", async () => {
      const { warmed } = await warm({ os: "linux", arch: "amd64" });
      expect(warmed.materialized).toBe(0);
      expect(fetched).toEqual([]);
      // The darwin layer is for another platform, not for want of an abi — so
      // it is not a gap. Each gap names the flag that determines the axis,
      // because that is the repair; a fetch gap names the failure instead.
      expect(warmed.gaps.map((gap) => gap.cause)).toEqual(["undetermined", "undetermined"]);
      expect(warmed.gaps[0].detail).toContain("the native layer node (linux/node-137) constrains abi");
      expect(warmed.gaps[1].detail).toContain("the controller layer js (linux/node-141) constrains abi");
      // A gap states the fact; the REMEDY belongs to whoever refuses, because
      // the flags differ — `telo package` accepts no `--abi` at all.
      for (const gap of warmed.gaps) expect(gap.detail).not.toContain("--abi");
      expect(describeGaps(warmed.gaps, "Name the target with --abi.")).toContain("--abi");
      expect(describeGaps(warmed.gaps)).not.toContain("--abi");
    });

    it("warms the layer matching --abi, not one stating another abi", async () => {
      const { warmed } = await warm({ os: "linux", arch: "amd64", abi: "node-137" });
      expect(fetched).toEqual([NATIVE_LAYERS[0].blob]);
      expect(warmed.materialized).toBe(1);
      expect(warmed.gaps).toEqual([]);

      fetched.length = 0;
      await warm({ os: "linux", arch: "amd64", abi: "telo-3" });
      expect(fetched).toEqual([]);
    });
  });
});

describe("parsePlatformTarget", () => {
  it("keeps --platform as it was and takes abi from --abi alone", () => {
    expect(parsePlatformTarget("linux/arm64/musl", "node-141")).toEqual({
      os: "linux",
      arch: "arm64",
      libc: "musl",
      abi: "node-141",
    });
    expect(parsePlatformTarget("linux/amd64", undefined)).toEqual({ os: "linux", arch: "amd64" });
    // Without `--platform` the target IS this machine, so its abi is not
    // discarded: a bare `telo install` has to warm the native layer the runtime
    // about to open it reports, and asking for `--abi` there names a flag for a
    // value already in hand.
    expect(parsePlatformTarget(undefined, undefined).abi).toBe(hostPlatformTarget().abi);
  });

  it("refuses an abi that is not <family>-<version>", () => {
    expect(() => parsePlatformTarget("linux/amd64", "141")).toThrow(/<family>-<version>/);
  });
});
