import { describe, expect, it } from "vitest";
import { parseFragment } from "../src/release/fragment.js";
import { EMPTY_LEDGER, parseLedger, serializeLedger } from "../src/release/ledger.js";
import { planRelease, type ModuleEvidence } from "../src/release/release-plan.js";
import type { Ledger } from "../src/release/ledger.js";

function moduleEvidence(over: Partial<ModuleEvidence> & { key: string }): ModuleEvidence {
  return {
    name: over.key,
    version: "1.0.0",
    artifactKind: "registry",
    layers: { manifest: "sha256-same" },
    inlines: new Map(),
    imports: [],
    ownFilesChanged: false,
    ...over,
  };
}

function ledger(entries: Record<string, { version: string; layers: Record<string, string> }>): Ledger {
  return { registry: "oci://example/org", modules: new Map(Object.entries(entries)) };
}

const fragment = (text: string, source = ".changes/pending/f.yaml") => parseFragment(text, source);

describe("planRelease — the digest decides WHETHER", () => {
  it("plans nothing when every payload matches the ledger", () => {
    const plan = planRelease({
      modules: [moduleEvidence({ key: "modules/sql" })],
      ledger: ledger({ "modules/sql": { version: "1.0.0", layers: { manifest: "sha256-same" } } }),
      fragments: [],
    });
    expect(plan.modules).toEqual([]);
  });

  it("does not treat a never-published module as drift", () => {
    // A missing entry means nothing is published — the correct reading for a new
    // module, and the one case where "differs from the ledger" is not a question.
    const plan = planRelease({
      modules: [moduleEvidence({ key: "modules/new", layers: { manifest: "sha256-x" } })],
      ledger: EMPTY_LEDGER,
      fragments: [],
    });
    expect(plan.modules).toEqual([]);
  });

  it("bumps a drifted module with no attribution as a patch, and says so", () => {
    const plan = planRelease({
      modules: [moduleEvidence({ key: "modules/test", layers: { manifest: "sha256-moved" } })],
      ledger: ledger({ "modules/test": { version: "0.9.3", layers: { manifest: "sha256-old" } } }),
      fragments: [],
    });
    // The ledger's version is authoritative for the comparison; the manifest's
    // must agree, so this case is really "version mismatch".
    expect(plan.diagnostics.map((d) => d.code)).toContain("LEDGER_VERSION_MISMATCH");
  });

  it("reports an unattributed payload move rather than hiding it", () => {
    const plan = planRelease({
      modules: [
        moduleEvidence({ key: "modules/test", version: "0.9.3", layers: { manifest: "sha256-moved" } }),
      ],
      ledger: ledger({ "modules/test": { version: "0.9.3", layers: { manifest: "sha256-old" } } }),
      fragments: [],
    });
    expect(plan.modules).toHaveLength(1);
    expect(plan.modules[0]).toMatchObject({ from: "0.9.3", to: "0.9.4", level: "patch" });
    expect(plan.modules[0].reasons).toEqual([{ kind: "unattributed" }]);
  });
});

describe("planRelease — the graph decides AT WHAT LEVEL", () => {
  it("mirrors a dependency's level onto a dependent whose payload inlined it", () => {
    const plan = planRelease({
      modules: [
        moduleEvidence({ key: "modules/sql", version: "0.13.1" }),
        moduleEvidence({
          key: "modules/sql-sqlite",
          version: "0.7.0",
          layers: { manifest: "sha256-moved" },
          inlines: new Map([["modules/sql", ["modules/sql/nodejs/src/query.ts"]]]),
        }),
      ],
      ledger: ledger({
        "modules/sql": { version: "0.13.1", layers: { manifest: "sha256-same" } },
        "modules/sql-sqlite": { version: "0.7.0", layers: { manifest: "sha256-old" } },
      }),
      fragments: [fragment("modules:\n  modules/sql: Added\nbody: A thing.")],
    });

    const bySql = Object.fromEntries(plan.modules.map((m) => [m.key, m]));
    expect(bySql["modules/sql"]).toMatchObject({ to: "0.14.0", level: "minor" });
    // A module that inlines a minor change is minor for its own consumers.
    expect(bySql["modules/sql-sqlite"]).toMatchObject({ to: "0.8.0", level: "minor" });
    expect(bySql["modules/sql-sqlite"].reasons).toContainEqual({
      kind: "inlines",
      module: "modules/sql",
      files: ["modules/sql/nodejs/src/query.ts"],
    });
  });

  it("bumps an importer even when its current digest has not moved", () => {
    // Publishing rewrites `../sql` to `<base>/sql@<version>`, so the dependent's
    // manifest layer provably changes when the dependency's version does — a
    // fact about the plan, which the pre-bump digest cannot yet show.
    const plan = planRelease({
      modules: [
        moduleEvidence({ key: "modules/sql", version: "0.13.1" }),
        moduleEvidence({
          key: "modules/sql-repository",
          version: "0.4.0",
          imports: ["modules/sql"],
        }),
      ],
      ledger: ledger({
        "modules/sql": { version: "0.13.1", layers: { manifest: "sha256-same" } },
        "modules/sql-repository": { version: "0.4.0", layers: { manifest: "sha256-same" } },
      }),
      fragments: [fragment("modules:\n  modules/sql: Fixed\nbody: A fix.")],
    });

    const repository = plan.modules.find((m) => m.key === "modules/sql-repository");
    expect(repository).toMatchObject({ to: "0.4.1", level: "patch" });
    expect(repository?.reasons).toContainEqual({ kind: "imports", module: "modules/sql" });
  });

  it("does not attribute an inline edge to a dependency whose payload did not move", () => {
    // A docs-only fragment on the dependency must not drag every dependent along:
    // if the inlined bytes had changed, the dependent's digest would say so.
    const plan = planRelease({
      modules: [
        moduleEvidence({ key: "modules/sql", version: "0.13.1" }),
        moduleEvidence({
          key: "modules/sql-sqlite",
          version: "0.7.0",
          inlines: new Map([["modules/sql", ["modules/sql/nodejs/src/query.ts"]]]),
        }),
      ],
      ledger: ledger({
        "modules/sql": { version: "0.13.1", layers: { manifest: "sha256-same" } },
        "modules/sql-sqlite": { version: "0.7.0", layers: { manifest: "sha256-same" } },
      }),
      fragments: [fragment("modules:\n  modules/sql: Fixed\nbody: A fix.")],
    });
    expect(plan.modules.map((m) => m.key)).toEqual(["modules/sql"]);
  });

  it("takes the maximum level over several paths", () => {
    const plan = planRelease({
      modules: [
        moduleEvidence({ key: "modules/a", version: "1.0.0" }),
        moduleEvidence({ key: "modules/b", version: "1.0.0" }),
        moduleEvidence({ key: "modules/c", version: "1.0.0", imports: ["modules/a", "modules/b"] }),
      ],
      ledger: ledger({
        "modules/a": { version: "1.0.0", layers: { manifest: "sha256-same" } },
        "modules/b": { version: "1.0.0", layers: { manifest: "sha256-same" } },
        "modules/c": { version: "1.0.0", layers: { manifest: "sha256-same" } },
      }),
      fragments: [
        fragment("modules:\n  modules/a: Fixed\nbody: patch.", ".changes/pending/a.yaml"),
        fragment("modules:\n  modules/b: Added\nbody: minor.", ".changes/pending/b.yaml"),
      ],
    });
    expect(plan.modules.find((m) => m.key === "modules/c")).toMatchObject({ level: "minor" });
  });

  it("propagates through an unattributed bump, so a toolchain move reaches dependents", () => {
    const plan = planRelease({
      modules: [
        moduleEvidence({ key: "modules/a", version: "1.0.0", layers: { manifest: "sha256-moved" } }),
        moduleEvidence({ key: "modules/b", version: "1.0.0", imports: ["modules/a"] }),
      ],
      ledger: ledger({
        "modules/a": { version: "1.0.0", layers: { manifest: "sha256-old" } },
        "modules/b": { version: "1.0.0", layers: { manifest: "sha256-same" } },
      }),
      fragments: [],
    });
    expect(plan.modules.map((m) => m.key).sort()).toEqual(["modules/a", "modules/b"]);
  });

  it("orders the plan so a dependency precedes its dependents", () => {
    const plan = planRelease({
      modules: [
        moduleEvidence({ key: "modules/z", version: "1.0.0", imports: ["modules/a"] }),
        moduleEvidence({ key: "modules/a", version: "1.0.0" }),
      ],
      ledger: ledger({
        "modules/a": { version: "1.0.0", layers: { manifest: "sha256-same" } },
        "modules/z": { version: "1.0.0", layers: { manifest: "sha256-same" } },
      }),
      fragments: [fragment("modules:\n  modules/a: Fixed\nbody: fix.")],
    });
    expect(plan.modules.map((m) => m.key)).toEqual(["modules/a", "modules/z"]);
  });
});

describe("planRelease — what makes a plan inconsistent", () => {
  it("rejects a fragment naming a module that does not exist", () => {
    const plan = planRelease({
      modules: [moduleEvidence({ key: "modules/sql" })],
      ledger: EMPTY_LEDGER,
      fragments: [fragment("modules:\n  sql: Fixed\nbody: a fix.")],
    });
    expect(plan.diagnostics.map((d) => d.code)).toEqual(["FRAGMENT_UNKNOWN_MODULE"]);
  });

  it("rejects a major-inducing kind, since modules are intentionally pre-1.0", () => {
    const plan = planRelease({
      modules: [moduleEvidence({ key: "modules/sql" })],
      ledger: EMPTY_LEDGER,
      fragments: [fragment("modules:\n  modules/sql: Removed\nbody: gone.")],
    });
    expect(plan.diagnostics.map((d) => d.code)).toEqual(["MAJOR_BUMP_REJECTED"]);
    expect(plan.modules).toEqual([]);
  });

  it("rejects digests taken against another registry base", () => {
    const plan = planRelease({
      modules: [moduleEvidence({ key: "modules/sql" })],
      ledger: ledger({ "modules/sql": { version: "1.0.0", layers: { manifest: "sha256-same" } } }),
      fragments: [],
      registry: "oci://other/org",
    });
    expect(plan.diagnostics.map((d) => d.code)).toContain("LEDGER_REGISTRY_MISMATCH");
  });

  it("asks for a changelog entry — as a WARNING — when a module's own files changed", () => {
    const plan = planRelease({
      modules: [moduleEvidence({ key: "modules/sql", ownFilesChanged: true })],
      ledger: ledger({ "modules/sql": { version: "1.0.0", layers: { manifest: "sha256-same" } } }),
      fragments: [],
    });
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", code: "CHANGELOG_ENTRY_REQUESTED" }),
    ]);
  });

  it("asks ONCE, naming them all", () => {
    // A change that touches every module's build script asks the same question
    // about forty of them, and forty copies of one sentence bury the plan they
    // are printed beside. One fragment answers all of them, so it is one ask.
    const plan = planRelease({
      modules: [
        moduleEvidence({ key: "modules/a", ownFilesChanged: true }),
        moduleEvidence({ key: "modules/b", ownFilesChanged: true }),
        moduleEvidence({ key: "modules/c", ownFilesChanged: true }),
      ],
      ledger: EMPTY_LEDGER,
      fragments: [],
    });
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0].message).toContain("3 module(s)");
    expect(plan.diagnostics[0].message).toContain("modules/a, modules/b, modules/c");
  });

  it("does not ask for prose from a module that only drifted", () => {
    // Under a toolchain bump every digest moves; demanding sixty fragments for
    // that is what this design explicitly refuses to do.
    const plan = planRelease({
      modules: [moduleEvidence({ key: "modules/sql", layers: { manifest: "sha256-moved" } })],
      ledger: ledger({ "modules/sql": { version: "1.0.0", layers: { manifest: "sha256-old" } } }),
      fragments: [],
    });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.modules).toHaveLength(1);
  });
});

describe("ledger", () => {
  it("round-trips", () => {
    const original = ledger({
      "modules/sql": { version: "0.13.1", layers: { manifest: "sha256-a", "controller/js": "sha256-b" } },
    });
    const parsed = parseLedger(serializeLedger(original), "ledger.yaml");
    expect(parsed.registry).toBe("oci://example/org");
    expect(parsed.modules.get("modules/sql")).toEqual({
      version: "0.13.1",
      layers: { manifest: "sha256-a", "controller/js": "sha256-b" },
    });
  });

  it("refuses an entry with no version, because a digest without one says nothing", () => {
    expect(() => parseLedger("modules:\n  modules/sql:\n    layers: {}\n", "ledger.yaml")).toThrow(
      /no major\.minor\.patch 'version'/,
    );
  });
});

describe("fragments", () => {
  it("maps several modules in one file, which is what a cross-cutting change is", () => {
    const parsed = fragment("modules:\n  modules/a: Fixed\n  modules/b: Added\nbody: one change.");
    expect([...parsed.modules]).toEqual([
      ["modules/a", "Fixed"],
      ["modules/b", "Added"],
    ]);
  });

  it("refuses an unknown kind rather than defaulting it", () => {
    expect(() => fragment("modules:\n  modules/a: Tweaked\nbody: x.")).toThrow(
      /not a release kind/,
    );
  });
});
