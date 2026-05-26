import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";

/**
 * Regression coverage for two bugs that historically only surfaced at runtime:
 *
 *   1. Two resources sharing a `metadata.name` across kinds (e.g.
 *      `Telo.Application HelloApi` + `Http.Api HelloApi`) — the kernel
 *      rejects this at boot with `ERR_DUPLICATE_RESOURCE`. The analyzer
 *      should emit `DUPLICATE_RESOURCE_NAME` so the same problem is caught
 *      by `pnpm run check`.
 *
 *   2. An object-form `{kind, name}` reference whose kind prefix doesn't
 *      correspond to any declared `Telo.Import` alias, but whose `name`
 *      happens to match a locally-defined resource (e.g.
 *      `{kind: JavaScript.Script, name: SayHello}` when only `JS` is
 *      imported and a `JS.Script` named `SayHello` exists). The kernel
 *      surfaces this as `ERR_RESOURCE_NOT_INVOKABLE` at request time. The
 *      analyzer should flag the bad prefix at static-check time.
 */

// Library that publishes two kinds. Namespace+name pair gives the analyzer's
// identity registry an entry of `"std/lib"` → `"lib"`, so `x-telo-ref`
// strings like `"std/lib#Script"` resolve to canonical `"lib.Script"`.
const library: ResourceManifest = {
  kind: "Telo.Library",
  metadata: { name: "lib", namespace: "std" },
  exports: { kinds: ["Script", "Dispatcher"] },
} as unknown as ResourceManifest;

const scriptDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "lib", namespace: "std" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: { code: { type: "string" } } },
} as unknown as ResourceManifest;

const dispatcherDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Dispatcher", module: "lib", namespace: "std" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      handler: { "x-telo-ref": "std/lib#Script" },
    },
  },
} as unknown as ResourceManifest;

// User application that imports the library under alias `Lib`.
const userApp: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "TestApp", version: "1.0.0" },
} as unknown as ResourceManifest;

const userImport: ResourceManifest = {
  kind: "Telo.Import",
  metadata: { name: "Lib", resolvedModuleName: "lib", resolvedNamespace: "std" },
  source: "../lib",
} as unknown as ResourceManifest;

const base = [userApp, userImport, library, scriptDef, dispatcherDef];

describe("duplicate metadata.name across kinds", () => {
  it("emits DUPLICATE_RESOURCE_NAME when two non-system resources share a name", () => {
    const first: ResourceManifest = {
      kind: "Lib.Script",
      metadata: { name: "Collide" },
      code: "noop",
    } as unknown as ResourceManifest;
    const second: ResourceManifest = {
      kind: "Lib.Dispatcher",
      metadata: { name: "Collide" },
      handler: { kind: "Lib.Script", name: "Collide" },
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze([...base, first, second]);
    const dup = diags.find((d) => d.code === "DUPLICATE_RESOURCE_NAME");
    expect(dup, JSON.stringify(diags, null, 2)).toBeDefined();
    expect(dup!.message).toContain("Collide");
    expect(dup!.message).toContain("Lib.Script");
    expect(dup!.message).toContain("Lib.Dispatcher");
  });

  it("emits DUPLICATE_RESOURCE_NAME when a Telo.Application's name collides with a resource", () => {
    const collidingApp: ResourceManifest = {
      kind: "Telo.Application",
      metadata: { name: "HelloApi", version: "1.0.0" },
    } as unknown as ResourceManifest;
    const collidingResource: ResourceManifest = {
      kind: "Lib.Script",
      metadata: { name: "HelloApi" },
      code: "noop",
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze([
      userImport,
      library,
      scriptDef,
      dispatcherDef,
      collidingApp,
      collidingResource,
    ]);
    const dup = diags.find((d) => d.code === "DUPLICATE_RESOURCE_NAME");
    expect(dup, JSON.stringify(diags, null, 2)).toBeDefined();
    expect(dup!.message).toContain("HelloApi");
  });

  it("does NOT emit DUPLICATE_RESOURCE_NAME when names are unique", () => {
    const a: ResourceManifest = {
      kind: "Lib.Script",
      metadata: { name: "OnlyOne" },
      code: "noop",
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze([...base, a]);
    const dup = diags.find((d) => d.code === "DUPLICATE_RESOURCE_NAME");
    expect(dup).toBeUndefined();
  });

  it("does NOT count Telo.Definition / Telo.Abstract as duplicates of resources", () => {
    // A user resource shares a name with one of the loaded Telo.Definitions
    // ("Script") — but definitions and abstracts are type blueprints, not
    // resource instances, so they must not participate in the duplicate
    // check. Only the two `Lib.Script` instances below are duplicates.
    const scriptInstanceA: ResourceManifest = {
      kind: "Lib.Script",
      metadata: { name: "Script" },
      code: "noop",
    } as unknown as ResourceManifest;
    const scriptInstanceB: ResourceManifest = {
      kind: "Lib.Dispatcher",
      metadata: { name: "Script" },
      handler: { kind: "Lib.Script", name: "Script" },
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze([...base, scriptInstanceA, scriptInstanceB]);
    const dups = diags.filter((d) => d.code === "DUPLICATE_RESOURCE_NAME");
    expect(dups.length, JSON.stringify(diags, null, 2)).toBe(1);
    expect(dups[0].message).toContain("Script");
  });
});

// An abstract target like `Telo.Invocable` mirrors `Http.Api.routes[].handler`
// in the real http-server module. The bug from `hello-api.yaml` hit this
// branch — checkKind's abstract-target path is the one that needs the fix.
const invocableAbstract: ResourceManifest = {
  kind: "Telo.Abstract",
  metadata: { name: "RouteHandler", module: "lib", namespace: "std" },
  schema: { type: "object" },
} as unknown as ResourceManifest;

const abstractDispatcherDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "AbstractDispatcher", module: "lib", namespace: "std" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      handler: { "x-telo-ref": "std/lib#RouteHandler" },
    },
  },
} as unknown as ResourceManifest;

// `scriptDef` already has `capability: "Telo.Invocable"`. Give it a second
// `capability: "Lib.RouteHandler"` route by registering a parallel definition
// that explicitly extends the new abstract.
const scriptImplDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "HandlerScript", module: "lib", namespace: "std" },
  capability: "lib.RouteHandler",
  schema: { type: "object", properties: { code: { type: "string" } } },
} as unknown as ResourceManifest;

const abstractBase = [
  userApp,
  userImport,
  library,
  invocableAbstract,
  abstractDispatcherDef,
  scriptImplDef,
];

describe("object-form reference with an unknown alias prefix (abstract target)", () => {
  it("flags a bad alias when the slot's target is a Telo.Abstract", () => {
    // Mirrors hello-api.yaml's bug: handler kind uses an unimported alias,
    // and the slot expects anything implementing an abstract. The same-named
    // resource exists, so the name-only path doesn't flag it.
    const knownImpl: ResourceManifest = {
      kind: "Lib.HandlerScript",
      metadata: { name: "DoStuff" },
      code: "noop",
    } as unknown as ResourceManifest;
    const dispatcher: ResourceManifest = {
      kind: "Lib.AbstractDispatcher",
      metadata: { name: "Main" },
      handler: { kind: "NotAnAlias.HandlerScript", name: "DoStuff" },
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze([...abstractBase, knownImpl, dispatcher]);
    const bad = diags.find(
      (d) => d.code === "REFERENCE_KIND_MISMATCH" || d.code === "UNKNOWN_KIND_ALIAS",
    );
    expect(bad, JSON.stringify(diags, null, 2)).toBeDefined();
    expect(bad!.message).toContain("NotAnAlias");
  });
});

describe("object-form reference with an unknown alias prefix", () => {
  it("flags a {kind, name} ref whose alias prefix isn't imported", () => {
    // The `name` ("DoStuff") matches a real resource, so the unresolved-name
    // path doesn't catch this. The bug today: the unknown alias resolves to
    // the raw kind string and the kind-mismatch check below either treats it
    // as partial context or quietly produces no error.
    const knownScript: ResourceManifest = {
      kind: "Lib.Script",
      metadata: { name: "DoStuff" },
      code: "noop",
    } as unknown as ResourceManifest;
    const dispatcher: ResourceManifest = {
      kind: "Lib.Dispatcher",
      metadata: { name: "Main" },
      handler: { kind: "NotAnAlias.Script", name: "DoStuff" },
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze([...base, knownScript, dispatcher]);
    const bad = diags.find(
      (d) => d.code === "REFERENCE_KIND_MISMATCH" || d.code === "UNKNOWN_KIND_ALIAS",
    );
    expect(bad, JSON.stringify(diags, null, 2)).toBeDefined();
    expect(bad!.message).toContain("NotAnAlias");
  });

  it("still passes when the alias prefix IS imported and resolves to the right kind", () => {
    const knownScript: ResourceManifest = {
      kind: "Lib.Script",
      metadata: { name: "DoStuff" },
      code: "noop",
    } as unknown as ResourceManifest;
    const dispatcher: ResourceManifest = {
      kind: "Lib.Dispatcher",
      metadata: { name: "Main" },
      handler: { kind: "Lib.Script", name: "DoStuff" },
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze([...base, knownScript, dispatcher]);
    const bad = diags.find(
      (d) => d.code === "REFERENCE_KIND_MISMATCH" || d.code === "UNKNOWN_KIND_ALIAS",
    );
    expect(bad).toBeUndefined();
  });
});
