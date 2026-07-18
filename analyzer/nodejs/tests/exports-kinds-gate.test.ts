import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { resolveExportedKinds, stampExportedKinds } from "../src/flatten-for-analyzer.js";
import type { ResourceManifest } from "@telorun/sdk";

/**
 * The `exports.kinds` gate — a library's kinds are reachable by importers only when
 * listed. The analyzer's half of this gate was dead code for its entire existence: it
 * read `exports.kinds` off the `Telo.Import` doc, which has no such field, so the list
 * was always empty and nothing was ever rejected. Nothing failed, because nothing tested
 * it.
 *
 * These assert the properties that make the analyzer agree with the kernel, not merely
 * that some code path fires:
 *
 *   - a listed kind resolves, an unlisted one reports WHY (gated, not "unknown");
 *   - the gate cannot be sidestepped by an alias that happens to equal the module name;
 *   - `[]` (exports nothing) stays distinct from absent (legacy: exports everything);
 *   - a re-export whose source module is ungated still resolves, since the kernel
 *     derives that gate from the raw entry list and allows it.
 */
describe("exports.kinds gate — AliasResolver", () => {
  it("resolves a listed kind and reports an unlisted one as gated, not unknown", () => {
    const r = new AliasResolver();
    r.registerImport("Lib", "lib", ["Public"]);

    expect(r.resolveKindResult("Lib.Public")).toEqual({ status: "ok", kind: "lib.Public" });
    expect(r.resolveKindResult("Lib.Private")).toEqual({
      status: "gated",
      module: "lib",
      exported: ["Public"],
    });
    // An alias nobody imported is a different failure and must stay distinguishable —
    // it is what lets the caller emit "no such kind" instead of "not exported".
    expect(r.resolveKindResult("Nope.Thing")).toEqual({ status: "unknown" });
    expect(r.resolveKindResult("Unqualified")).toEqual({ status: "unknown" });
  });

  it("treats an empty exports.kinds as exporting nothing, and an absent one as ungated", () => {
    const gatedToNothing = new AliasResolver();
    gatedToNothing.registerImport("Lib", "lib", []);
    expect(gatedToNothing.resolveKindResult("Lib.Anything")).toEqual({
      status: "gated",
      module: "lib",
      exported: [],
    });

    // `undefined` is reserved for aliases crossing no import boundary (`Self`, `Telo`
    // built-ins) and the legacy permissive default. It must NOT collapse into `[]`.
    const ungated = new AliasResolver();
    ungated.registerImport("Self", "lib");
    expect(ungated.resolveKindResult("Self.Anything")).toEqual({
      status: "ok",
      kind: "lib.Anything",
    });
  });

  it("gates a kind even when the import alias equals the target module's name", () => {
    // The definition registry is keyed `<module>.<Kind>`, so `Foo` imported as `Foo` makes
    // the raw kind string a valid registry key. A caller that looks the definition up before
    // consulting the gate accepts an unexported kind the kernel rejects.
    const r = new AliasResolver();
    r.registerImport("Foo", "Foo", ["Public"]);
    expect(r.resolveKindResult("Foo.Private")).toEqual({
      status: "gated",
      module: "Foo",
      exported: ["Public"],
    });
  });

  it("lets an explicitly re-exported kind through, resolved to its true owner", () => {
    const r = new AliasResolver();
    r.registerImport("Gw", "gateway", ["Equals"]);
    r.registerKindReExport("Gw", "Equals", "assert.Equals");
    expect(r.resolveKindResult("Gw.Equals")).toEqual({ status: "ok", kind: "assert.Equals" });
  });
});

describe("exports.kinds gate — resolveExportedKinds", () => {
  const noAliases = () => undefined;

  it("resolves a re-export whose source module declares no exports.kinds", () => {
    // The migration path: a gated wrapper re-exporting from an already-published module
    // that predates explicit exports. The kernel allows it (its gate is the raw entry
    // list), so the analyzer must too — otherwise it rejects a manifest that runs.
    const table = resolveExportedKinds(
      [
        { module: "bee", exportsKinds: ["Cee.Thing"] },
        { module: "cee", exportsKinds: undefined },
      ],
      (module, alias) => (module === "bee" && alias === "Cee" ? "cee" : undefined),
    );
    expect(table.get("bee")?.get("Thing")).toBe("cee.Thing");
  });

  it("does not invent a re-export from a source that gates the kind out", () => {
    const table = resolveExportedKinds(
      [
        { module: "bee", exportsKinds: ["Cee.Thing"] },
        { module: "cee", exportsKinds: ["Other"] },
      ],
      (module, alias) => (module === "bee" && alias === "Cee" ? "cee" : undefined),
    );
    expect(table.get("bee")?.has("Thing")).toBe(false);
  });
});

describe("exports.kinds gate — stampExportedKinds", () => {
  const importDoc = (): ResourceManifest =>
    ({ kind: "Telo.Import", metadata: { name: "Lib" } }) as unknown as ResourceManifest;

  it("stamps the declared entries, reducing a re-export to its bare suffix", () => {
    const manifest = importDoc();
    // Mirrors the kernel's `parseExportEntry` — `Cee.Thing` gates the name `Thing`.
    stampExportedKinds([{ manifest, targetModule: "lib" }], new Map([["lib", ["Thing"]]]));
    expect((manifest.metadata as { exportedKinds?: string[] }).exportedKinds).toEqual(["Thing"]);
  });

  it("leaves an undeclared target unstamped, so it reads as ungated", () => {
    const manifest = importDoc();
    stampExportedKinds([{ manifest, targetModule: "lib" }], new Map());
    expect((manifest.metadata as { exportedKinds?: string[] }).exportedKinds).toBeUndefined();
  });

  it("stamps an empty gate, which is not the same as leaving it unstamped", () => {
    const manifest = importDoc();
    stampExportedKinds([{ manifest, targetModule: "lib" }], new Map([["lib", []]]));
    expect((manifest.metadata as { exportedKinds?: string[] }).exportedKinds).toEqual([]);
  });
});
