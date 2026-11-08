import { describe, expect, it } from "vitest";

import type { ResourceManifest } from "@telorun/sdk";

import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";
import { readRequires } from "../src/requires-block.js";
import { TELO_RUNNING_SURFACE } from "../src/telo-version.js";
import { Loader } from "../src/manifest-loader.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { collectModuleDocuments } from "../src/index.js";
import type { ManifestSource } from "../src/types.js";
import { validateRequires } from "../src/validate-requires.js";
import { DiagnosticSeverity } from "../src/types.js";

function doc(requires: unknown, name = "SQL") {
  return {
    kind: "Telo.Library",
    metadata: { name, source: `file:///${name}/telo.yaml`, module: name },
    ...(requires === undefined ? {} : { requires }),
  } as never;
}

describe("readRequires", () => {
  it("distinguishes an absent block from an empty one", () => {
    expect(readRequires({}).declared).toBe(false);
    expect(readRequires({ requires: {} }).declared).toBe(true);
  });

  it("parses the telo axis and nested host axes", () => {
    const { block, issues } = readRequires({
      requires: { telo: ">=0.80.0", host: { node: ">=20.0.0" } },
    });
    expect(issues).toEqual([]);
    expect(block.telo?.raw).toBe(">=0.80.0");
    expect(block.host.node?.raw).toBe(">=20.0.0");
  });

  // An axis is in the vocabulary only when something checks it. `rustc` has no
  // supplier yet, so an author writing it is told so rather than quietly
  // reassured by a requirement nothing will ever compare.
  it("rejects a host axis nothing enforces yet", () => {
    const { block, issues } = readRequires({ requires: { host: { rustc: ">=1.75.0" } } });
    expect(block.host).toEqual({});
    expect(issues[0]).toMatchObject({ path: "requires.host.rustc", unknownAxis: true });
  });

  it("reports an unknown axis at either tier and flags it as such", () => {
    const { issues } = readRequires({ requires: { tello: ">=0.1.0", host: { pytohn: ">=3.0.0" } } });
    expect(issues.map((i) => i.path)).toEqual(["requires.tello", "requires.host.pytohn"]);
    expect(issues.every((i) => i.unknownAxis)).toBe(true);
  });

  // A malformed range must never reach the block as a satisfied requirement.
  it("omits a malformed range from the block while reporting it", () => {
    const { block, issues } = readRequires({ requires: { telo: "^0.80.0" } });
    expect(block.telo).toBeUndefined();
    expect(issues[0]?.hint).toBe(">=0.80.0");
  });

  it("rejects non-mapping shapes at both tiers", () => {
    expect(readRequires({ requires: ">=0.1.0" }).issues[0]?.path).toBe("requires");
    expect(readRequires({ requires: { host: "node" } }).issues[0]?.path).toBe("requires.host");
  });

  it("reports a range whose bounds exclude each other", () => {
    const { block, issues } = readRequires({ requires: { telo: ">=0.90.0 <0.80.0" } });
    expect(block.telo).toBeUndefined();
    expect(issues[0]?.message).toContain("admits no version");
  });

  // Kept in the block, because a published manifest's ceiling is honoured.
  it("flags an upper bound on requires.telo as a ceiling and keeps the range", () => {
    const { block, issues } = readRequires({ requires: { telo: ">=0.119.0 <0.121.0" } });
    expect(block.telo?.raw).toBe(">=0.119.0 <0.121.0");
    expect(issues).toEqual([
      {
        path: "requires.telo",
        ceiling: true,
        message:
          "requires.telo '>=0.119.0 <0.121.0' declares an upper bound; requires.telo is a floor " +
          "only. Write the ceiling as a restrictions: entry without versions, which covers this version.",
      },
    ]);
  });

  it("keeps both bounds on host.node", () => {
    const { block, issues } = readRequires({ requires: { host: { node: ">=20.0.0 <24.0.0" } } });
    expect(issues).toEqual([]);
    expect(block.host.node?.raw).toBe(">=20.0.0 <24.0.0");
  });

  it("reads '>=unreleased' as the floor of the pending release, and only alone", () => {
    expect(readRequires({ requires: { telo: ">=unreleased" } })).toMatchObject({
      block: { telo: { raw: ">=unreleased", comparators: [], unreleased: true } },
      issues: [],
    });
    const combined = readRequires({ requires: { telo: ">=unreleased <0.200.0" } });
    expect(combined.block.telo).toBeUndefined();
    expect(combined.issues[0]?.message).toBe(
      "requires.telo '>=unreleased <0.200.0': unreleased is allowed only as the whole range '>=unreleased'.",
    );
    const host = readRequires({ requires: { host: { node: ">=unreleased" } } });
    expect(host.block.host).toEqual({});
    expect(host.issues[0]?.message).toBe(
      "requires.host.node '>=unreleased': unreleased names a telo release and is allowed only as a telo floor.",
    );
  });
});

describe("validateRequires", () => {
  it("gates a module the runtime is too old for", () => {
    const diagnostics = validateRequires([doc({ telo: ">=999.0.0" })]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MODULE_REQUIRES_NEWER_RUNTIME",
      severity: DiagnosticSeverity.Error,
    });
    expect(diagnostics[0]?.message).toBe(
      `SQL requires telo '>=999.0.0'; this runtime reports ${TELO_RUNNING_SURFACE}. Upgrade telo.`,
    );
  });

  // In source the ceiling is refused, and not enforced beside its refusal.
  it("refuses an upper bound on the entry's own requires.telo without gating on it", () => {
    const diagnostics = validateRequires([doc({ telo: ">=0.1.0 <0.2.0" }, "Mine")], {
      entryModules: new Set(["Mine"]),
    });
    expect(diagnostics.map((d) => [d.code, d.severity, (d.data as any).path])).toEqual([
      ["REQUIRES_INVALID", DiagnosticSeverity.Error, "requires.telo"],
    ]);
  });

  // A published manifest's ceiling is a restriction of that version.
  it("honours a dependency's upper bound as a ceiling", () => {
    const diagnostics = validateRequires([doc({ telo: ">=0.1.0 <0.2.0" }, "Theirs")], {
      entryModules: new Set(["Mine"]),
    });
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      [
        "MODULE_REQUIRES_OLDER_RUNTIME",
        `file:///Theirs/telo.yaml is restricted to telo '<0.2.0'; this runtime reports ` +
          `${TELO_RUNNING_SURFACE}. Use telo below 0.2.0, or another version of Theirs.`,
      ],
    ]);
  });

  // The running build is unreleased exactly when a telo-line changeset is pending.
  it("meets '>=unreleased' exactly when this build is of the pending release", () => {
    const codes = validateRequires([doc({ telo: ">=unreleased" })]).map((d) => d.code);
    expect(codes).toEqual(TELO_RUNNING_SURFACE.endsWith("+unreleased") ? [] : ["MODULE_REQUIRES_NEWER_RUNTIME"]);
  });

  it("says nothing when the requirement is met", () => {
    expect(validateRequires([doc({ telo: ">=0.1.0" })])).toEqual([]);
  });

  // A published dependency's malformed block is not the consumer's to FIX — but
  // it must not be silent either, or the load path would accept a module stating
  // an unreadable requirement while `telo upgrade` refuses to select it, with
  // nothing explaining the disagreement. Severity carries that split.
  it("errors on the entry's own malformed block and warns on a dependency's", () => {
    const manifests = [doc({ telo: "^0.80.0" }, "Mine"), doc({ telo: "^0.80.0" }, "Theirs")];
    const diagnostics = validateRequires(manifests, {
      entryModules: new Set(["Mine"]),
    });
    expect(diagnostics).toHaveLength(2);
    const mine = diagnostics.find((d) => (d.data as any)?.resource?.name === "Mine");
    const theirs = diagnostics.find((d) => (d.data as any)?.resource?.name === "Theirs");
    expect(mine?.severity).toBe(DiagnosticSeverity.Error);
    expect(theirs?.severity).toBe(DiagnosticSeverity.Warning);
    expect(theirs?.message).toMatch(/publisher/);
  });

  // An older runtime not knowing a newer axis is a consequence of the version
  // skew, not a second defect.
  it("suppresses unknown-axis complaints while the telo gate is failing", () => {
    const manifests = [doc({ telo: ">=999.0.0", host: { futureAxis: ">=1.0.0" }, other: "x" })];
    const codes = validateRequires(manifests).map((d) => d.code);
    expect(codes).toEqual(["MODULE_REQUIRES_NEWER_RUNTIME"]);
  });

  it("reports an unknown axis once the telo requirement is satisfied", () => {
    const manifests = [doc({ telo: ">=0.10.0", futureAxis: "x" })];
    const codes = validateRequires(manifests).map((d) => d.code);
    expect(codes).toEqual(["REQUIRES_INVALID"]);
  });

  it("ignores non-module docs", () => {
    const definition = { kind: "Telo.Definition", metadata: { name: "Query" }, requires: 5 };
    expect(validateRequires([definition as never])).toEqual([]);
  });
});

/**
 * The gate's suppression, asserted through the real `analyze()` pass.
 *
 * This is the property the whole mechanism turns on and the one that cannot be
 * stated in a manifest test: `Assert.Manifest` matches expectations by PRESENCE,
 * so an unsuppressed extra error would pass there unnoticed. A module too new to
 * read produces the vocabulary errors its syntax causes — every one of them true,
 * and every one of them blaming the module's author for a version skew — so the
 * gate must be the only thing reported for that module's files.
 */
describe("suppression of a module this runtime cannot read", () => {
  const app = (requires: unknown) =>
    withSyntheticPositions([
      {
        kind: "Telo.Application",
        metadata: { name: "FutureApp", source: "file:///app/telo.yaml", version: "1.0.0" },
        requires,
      },
      {
        kind: "NotImported.Missing",
        metadata: { name: "wouldNotResolve", source: "file:///app/telo.yaml" },
      },
    ] as unknown as ResourceManifest[]);

  it("reports the version skew and nothing else from that module's files", () => {
    const codes = new StaticAnalyzer()
      .analyze(app({ telo: ">=999.0.0" }))
      .filter((d) => d.severity === DiagnosticSeverity.Error)
      .map((d) => d.code);
    expect(codes).toEqual(["MODULE_REQUIRES_NEWER_RUNTIME"]);
  });

  it("suppresses the same way for a runtime above a ceiling", () => {
    const manifests = app(undefined);
    (manifests[0] as any).restrictions = [{ requires: { telo: "<0.1.0" }, reason: "Broken since 0.1.0." }];
    const codes = new StaticAnalyzer()
      .analyze(manifests)
      .filter((d) => d.severity === DiagnosticSeverity.Error)
      .map((d) => d.code);
    expect(codes).toEqual(["MODULE_REQUIRES_OLDER_RUNTIME"]);
  });

  // The counterpart: suppression must be exactly as wide as the skew, so a
  // satisfiable declaration hides nothing.
  it("reports the underlying errors once the requirement is satisfied", () => {
    const codes = new StaticAnalyzer()
      .analyze(app({ telo: ">=0.1.0" }))
      .filter((d) => d.severity === DiagnosticSeverity.Error)
      .map((d) => d.code);
    expect(codes).toContain("UNDEFINED_KIND");
    expect(codes).not.toContain("MODULE_REQUIRES_NEWER_RUNTIME");
  });
});

describe("the gate reaches a library the entry imports", () => {
  const files: Record<string, string> = {
    "/app/telo.yaml": "kind: Telo.Application\nmetadata: { name: App, version: 1.0.0 }\nimports: { Lib: ./lib }\n",
    "/app/lib/telo.yaml":
      'kind: Telo.Library\nmetadata: { name: Lib, version: 1.0.0 }\nrequires: { telo: ">=999.0.0" }\n',
  };
  const source: ManifestSource = {
    supports: () => true,
    async read(at: string) {
      const text = files[at];
      if (text === undefined) throw new Error(`File not found: ${at}`);
      return { text, source: at };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname.replace(/\/$/, "") + "/telo.yaml",
  };

  it("judges a library holding only its module document", async () => {
    const loaded = await new Loader([source]).loadGraph("/app/telo.yaml", { desugarImports: true });
    const codes = new StaticAnalyzer()
      .analyze(flattenForAnalyzer(loaded), { moduleDocuments: collectModuleDocuments(loaded) })
      .map((d) => d.code);
    expect(codes).toContain("MODULE_REQUIRES_NEWER_RUNTIME");
  });
});
