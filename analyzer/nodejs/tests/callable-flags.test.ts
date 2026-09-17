import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { CallableFlagsIndex } from "../src/callable-flags.js";
import type { ModuleFunctionIndex } from "../src/module-function-index.js";

/** Functions written in CEL, by name, each body calling through `Self`. */
function index(bodies: Record<string, string>): {
  flags: CallableFlagsIndex;
  manifest: (name: string) => ResourceManifest;
} {
  const manifests = new Map(
    Object.keys(bodies).map((name) => [
      name,
      { kind: "Telo.Function", metadata: { name } } as unknown as ResourceManifest,
    ]),
  );
  const functions = {
    resolve: (_caller: ResourceManifest, qualified: string) => {
      const manifest = manifests.get(qualified.slice("Self.".length));
      return manifest ? { status: "resolved", manifest } : { status: "unresolved" };
    },
    bodyOf: (manifest: ResourceManifest) => ({ source: bodies[manifest.metadata.name as string] }),
    claimsDeterministic: () => false,
  } as unknown as ModuleFunctionIndex;
  return {
    flags: new CallableFlagsIndex(functions, new Map([["", new Set(["Self", "Telo"])]])),
    manifest: (name) => manifests.get(name)!,
  };
}

describe("derived function flags", () => {
  it("gives every function in a call cycle the flags its own calls earn, whichever is asked first", () => {
    const { flags, manifest } = index({ a: "Self.b(1) + string(now())", b: "Self.a(1)" });
    expect(flags.ofResource(manifest("a"), "a")).toMatchObject({
      deterministic: false,
      nondeterministicVia: ["a", "now()"],
    });
    expect(flags.ofResource(manifest("b"), "b")).toMatchObject({
      deterministic: false,
      nondeterministicVia: ["b", "Self.a", "now()"],
    });
  });

  it("treats a call reaching no function as neither deterministic nor host-free", () => {
    const { flags, manifest } = index({ a: "Self.missing(1)" });
    expect(flags.ofResource(manifest("a"), "a")).toEqual({
      deterministic: false,
      hostBacked: true,
      nondeterministicVia: ["a", "Self.missing"],
      hostBackedVia: ["a", "Self.missing"],
    });
  });
});
