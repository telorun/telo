import type { CompiledValue, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { nodeIdFor } from "../src/call-graph.js";
import { declarationSignature, diffManifests } from "../src/manifest-diff.js";

/** A precompiled expression as the loader leaves one in a manifest. Built here
 *  rather than through the CEL engine: what the signature reads is the source
 *  text and the marker, and nothing in this file evaluates anything. */
const cel = (source: string): CompiledValue =>
  ({ __compiled: true, source, call: () => undefined }) as unknown as CompiledValue;

const res = (
  name: string,
  body: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): ResourceManifest =>
  ({
    kind: "Sql.Connection",
    metadata: { name, module: "app", ...metadata },
    ...body,
  }) as unknown as ResourceManifest;

/** The id the diff keys by, derived rather than spelled out — the format is
 *  `nodeIdFor`'s to choose, and a test that restates it tests the restatement. */
const id = (name: string, module = "app"): string => nodeIdFor(res(name, {}, { module }));

describe("declarationSignature", () => {
  it("ignores loader stamps, so an edit above a resource does not move it", () => {
    // The load-bearing case: inserting a line shifts `sourceLine` for every
    // resource below it, which would otherwise mark a whole file changed on any
    // edit at all.
    const a = res("db", { url: "postgres://x" }, { sourceLine: 12, source: "file:///a.yaml" });
    const b = res("db", { url: "postgres://x" }, { sourceLine: 40, source: "file:///a.yaml" });
    expect(declarationSignature(a)).toBe(declarationSignature(b));
  });

  it("is insensitive to key order and sensitive to values", () => {
    const a = res("db", { url: "x", pool: 4 });
    const b = res("db", { pool: 4, url: "x" });
    const c = res("db", { pool: 5, url: "x" });
    expect(declarationSignature(a)).toBe(declarationSignature(b));
    expect(declarationSignature(a)).not.toBe(declarationSignature(c));
  });

  it("compares a compiled expression by its source text", () => {
    const a = res("db", { port: cel("variables.port") });
    const b = res("db", { port: cel("variables.port") });
    const c = res("db", { port: cel("variables.other") });
    expect(declarationSignature(a)).toBe(declarationSignature(b));
    expect(declarationSignature(a)).not.toBe(declarationSignature(c));
  });

  it("does not walk into a live instance injected over a reference slot", () => {
    // A host that has injected instances holds manifests that are no longer
    // declarations, and a controller's object graph is cyclic. Rendering one as
    // a constant is what keeps this terminating; comparing across the injection
    // boundary is unsupported, not merely imprecise.
    class Pool {
      self: Pool | undefined;
      constructor() {
        this.self = this;
      }
    }
    const live = res("repo", { connection: new Pool() });
    expect(() => declarationSignature(live)).not.toThrow();
  });

  it("terminates on a cyclic plain object", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => declarationSignature(res("db", { cyclic }))).not.toThrow();
  });
});

describe("diffManifests", () => {
  it("classifies additions, removals, changes and survivors", () => {
    const previous = [res("db", { url: "x" }), res("cache", {}), res("gone", {})];
    const next = [res("db", { url: "y" }), res("cache", {}), res("fresh", {})];

    const diff = diffManifests(previous, next);
    const byChange = (kind: string) =>
      diff.entries.filter((e) => e.change === kind).map((e) => e.id);

    expect(byChange("changed")).toEqual([id("db")]);
    expect(byChange("added")).toEqual([id("fresh")]);
    expect(byChange("removed")).toEqual([id("gone")]);
    expect(diff.unchanged).toEqual([id("cache")]);
  });

  it("puts every removal and change in `stale`, every addition and change in `pending`", () => {
    const previous = [res("db", { url: "x" }), res("gone", {})];
    const next = [res("db", { url: "y" }), res("fresh", {})];

    const diff = diffManifests(previous, next);
    expect([...diff.stale].sort()).toEqual([id("db"), id("gone")].sort());
    expect(diff.pending.map((m) => m.metadata.name).sort()).toEqual(["db", "fresh"]);
  });

  it("keys identity by declaring module, so one name in two modules is two resources", () => {
    const previous = [res("store", { size: 1 }, { module: "a" })];
    const next = [res("store", { size: 1 }, { module: "b" })];

    const diff = diffManifests(previous, next);
    expect(diff.unchanged).toEqual([]);
    expect(diff.entries.map((e) => e.change).sort()).toEqual(["added", "removed"]);
  });

  it("reports a resource changed when its module's resolved configuration moved", () => {
    // The declaration is identical, and `!cel \"variables.port\"` still means
    // something else once the environment behind it moves. Only the host that
    // resolved it knows, so it is supplied rather than derived.
    const manifest = res("db", { port: cel("variables.port") });
    const diff = diffManifests([manifest], [manifest], {
      modulesWithChangedConfig: new Set(["app"]),
    });

    expect(diff.unchanged).toEqual([]);
    expect(diff.entries.map((e) => e.change)).toEqual(["changed"]);
    expect(diff.stale).toEqual([id("db")]);
  });

  it("leaves other modules alone when one module's configuration moved", () => {
    const mine = res("db", {}, { module: "app" });
    const theirs = res("store", {}, { module: "lib" });
    const diff = diffManifests([mine, theirs], [mine, theirs], {
      modulesWithChangedConfig: new Set(["app"]),
    });

    expect(diff.unchanged).toEqual([id("store", "lib")]);
    expect(diff.stale).toEqual([id("db")]);
  });

  it("compares against a supplied signature, not against a mutated manifest", () => {
    // What a host that INSTALLS manifests faces: it registered the very objects
    // it loaded, and resolving a reference wrote a live instance into one. The
    // manifest on the previous side is no longer a declaration and signs as
    // opaque, so without the signature taken at load time this reports a change
    // that never happened — on a module document, every single time.
    const declaration = res("api", { routes: [{ handler: { kind: "Js.Script", name: "h" } }] });
    const signature = declarationSignature(declaration);

    const injected = res("api", { routes: [{ handler: new (class Live {})() }] });
    const reloaded = res("api", { routes: [{ handler: { kind: "Js.Script", name: "h" } }] });

    expect(diffManifests([injected], [reloaded]).entries).toHaveLength(1);
    expect(
      diffManifests([injected], [reloaded], {
        previousSignatures: new Map([[id("api"), signature]]),
      }).entries,
    ).toEqual([]);
  });

  it("signs from the manifest for an id the caller did not supply", () => {
    const set = [res("db", { url: "x" })];
    const diff = diffManifests(set, set, { previousSignatures: new Map() });
    expect(diff.entries).toEqual([]);
  });

  it("reports nothing for two identical loads", () => {
    const set = [res("db", { url: "x" }), res("cache", { size: 10 })];
    const diff = diffManifests(set, set);
    expect(diff.entries).toEqual([]);
    expect(diff.stale).toEqual([]);
    expect(diff.pending).toEqual([]);
    expect(diff.unchanged).toHaveLength(2);
  });
});
