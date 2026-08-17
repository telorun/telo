import { describe, expect, it } from "vitest";

import type { ResourceManifest } from "@telorun/sdk";

import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";
import { evaluateRequires, readRequires } from "../src/requires-block.js";
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
});

describe("evaluateRequires", () => {
  const block = (raw: string) => readRequires({ requires: { telo: raw } }).block;

  it("passes inside the range and fails outside it", () => {
    expect(evaluateRequires(block(">=0.80.0"), "0.80.0").satisfied).toBe(true);
    expect(evaluateRequires(block(">=0.80.0"), "0.76.0").satisfied).toBe(false);
    expect(evaluateRequires(block(">=0.40.0 <0.80.0"), "0.85.0").satisfied).toBe(false);
  });

  // Bootstrap: everything published before the mechanism existed declares
  // nothing, and none of it uses syntax that did not yet exist.
  it("treats an absent declaration as no requirement", () => {
    expect(evaluateRequires(readRequires({}).block, "0.1.0").satisfied).toBe(true);
  });

  // A runtime that cannot name its own generation must not start rejecting
  // modules on the strength of a number it could not read.
  it("passes when the running version is unknown or unparseable", () => {
    expect(evaluateRequires(block(">=0.80.0"), undefined).satisfied).toBe(true);
    expect(evaluateRequires(block(">=0.80.0"), "dev").satisfied).toBe(true);
  });

  // The editor has no host to speak for, so an axis with no supplied version is
  // skipped rather than guessed.
  it("skips a host axis when the caller supplies no version for it", () => {
    const { block: b } = readRequires({ requires: { host: { node: ">=99.0.0" } } });
    expect(evaluateRequires(b, "0.1.0").satisfied).toBe(true);
  });

  // ...but enforces it once a host does report one. A declared requirement that
  // nothing ever compares is the failure class this mechanism exists to remove.
  it("enforces a host axis against a supplied version", () => {
    const { block: b } = readRequires({ requires: { host: { node: ">=20.0.0" } } });
    expect(evaluateRequires(b, "0.1.0", { node: "22.1.0" }).satisfied).toBe(true);
    const verdict = evaluateRequires(b, "0.1.0", { node: "18.19.0" });
    expect(verdict).toMatchObject({ satisfied: false, axis: "node", running: "18.19.0" });
  });

  // `telo` short-circuits: a module using a later host axis also declares the
  // telo that defined it, so the skew must be reported before the axis.
  it("reports the telo skew before any host axis", () => {
    const { block: b } = readRequires({
      requires: { telo: ">=0.90.0", host: { node: ">=99.0.0" } },
    });
    expect(evaluateRequires(b, "0.76.0", { node: "20.0.0" })).toMatchObject({ axis: "telo" });
  });

  // The guard is a PARSE, not a shape test. `0.76` and `2024.1` look like
  // versions and are not three-part ones, so a leading-digit test would fail
  // them CLOSED and gate every module on a number nothing could compare —
  // exactly the direction this refuses to fail in. `teloVersion` is hand-written
  // by definition, so this is where such a value arrives.
  it("treats a version it cannot parse as satisfied, not as failing", () => {
    const b = readRequires({ requires: { telo: ">=0.80.0" } }).block;
    for (const running of ["0.76", "2024.1", "dev", "v", ""]) {
      expect(evaluateRequires(b, running).satisfied, running).toBe(true);
    }
    // A parseable one below the bound still fails, so the guard has not
    // swallowed the check itself.
    expect(evaluateRequires(b, "0.76.0").satisfied).toBe(false);
  });
});

describe("validateRequires", () => {
  it("gates a module the runtime is too old for", () => {
    const diagnostics = validateRequires([doc({ telo: ">=0.80.0" })], { teloVersion: "0.76.0" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MODULE_REQUIRES_NEWER_RUNTIME",
      severity: DiagnosticSeverity.Error,
    });
    expect(diagnostics[0]?.message).toContain(">=0.80.0");
    expect(diagnostics[0]?.message).toContain("0.76.0");
  });

  it("says nothing when the requirement is met", () => {
    expect(validateRequires([doc({ telo: ">=0.80.0" })], { teloVersion: "0.85.0" })).toEqual([]);
  });

  // A published dependency's malformed block is not the consumer's to FIX — but
  // it must not be silent either, or the load path would accept a module stating
  // an unreadable requirement while `telo upgrade` refuses to select it, with
  // nothing explaining the disagreement. Severity carries that split.
  it("errors on the entry's own malformed block and warns on a dependency's", () => {
    const manifests = [doc({ telo: "^0.80.0" }, "Mine"), doc({ telo: "^0.80.0" }, "Theirs")];
    const diagnostics = validateRequires(manifests, {
      teloVersion: "0.85.0",
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
    const manifests = [doc({ telo: ">=0.90.0", host: { futureAxis: ">=1.0.0" }, other: "x" })];
    const codes = validateRequires(manifests, { teloVersion: "0.76.0" }).map((d) => d.code);
    expect(codes).toEqual(["MODULE_REQUIRES_NEWER_RUNTIME"]);
  });

  it("reports an unknown axis once the telo requirement is satisfied", () => {
    const manifests = [doc({ telo: ">=0.10.0", futureAxis: "x" })];
    const codes = validateRequires(manifests, { teloVersion: "0.76.0" }).map((d) => d.code);
    expect(codes).toEqual(["REQUIRES_INVALID"]);
  });

  it("ignores non-module docs", () => {
    const definition = { kind: "Telo.Definition", metadata: { name: "Query" }, requires: 5 };
    expect(validateRequires([definition as never], { teloVersion: "0.1.0" })).toEqual([]);
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
