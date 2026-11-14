import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { PeerBinder, type RefSite, type ReferenceValue } from "../src/peer-binding.js";
import type { RefUse } from "../src/ref-slot.js";
import { resolvedReference } from "../src/resolved-reference.js";
import type { ReachableSpec } from "../src/resource-rule.js";

/** The walk behind `reachable:`, over declarations whose every `next` slot is a
 *  dependency and every `page` slot a shape. */

const SPEC: ReachableSpec = { kind: "std.Page", use: "schema", through: ["dependency"] };

const node = (name: string, next: string[], page?: string, extra: Record<string, unknown> = {}) =>
  ({
    kind: "std.Node",
    metadata: { name, module: "A", ...extra },
    next: next.map((target) => resolvedReference("std.Node", target)),
    ...(page ? { page: resolvedReference("std.Page", page) } : {}),
  }) as unknown as ResourceManifest;

const page = (name: string) => ({ kind: "std.Page", metadata: { name, module: "A" } }) as unknown as ResourceManifest;

function binderOver(declarations: ResourceManifest[], counted: { sites: number } = { sites: 0 }): PeerBinder {
  const byName = new Map(declarations.map((d) => [d.metadata!.name as string, d]));
  const site = (kind: string, use: RefUse): RefSite => ({ shape: "", kinds: [kind], uses: [use] });
  return new PeerBinder({
    declarationOf: (r: ReferenceValue) => byName.get(r.name),
    refSlotsOf: () => [],
    refSitesOf: (manifest) => {
      counted.sites++;
      const sites = new Map<string, RefSite>();
      const next = (manifest as unknown as { next?: unknown[] }).next ?? [];
      next.forEach((_, i) => sites.set(`next[${i}]`, site("std.Node", "dependency")));
      if ((manifest as unknown as { page?: unknown }).page) sites.set("page", site("std.Page", "schema"));
      return sites;
    },
    reach: {
      canonicalKind: (declaration) => String(declaration.kind),
      isKindOf: (candidate, ancestor) => candidate === ancestor,
      isDependency: () => false,
      stepSlotsOf: () => [],
    },
  });
}

const reachedNames = (binder: PeerBinder, root: ResourceManifest) => {
  const walk = binder.reachable(root, root.kind, SPEC);
  if (!walk.ok) throw new Error(walk.failure.reason);
  return walk.references.map((r) => `${r.anchor.manifest.metadata?.name}.${r.anchor.path}->${(r.value.metadata as { name: string }).name}`);
};

describe("the reachable walk", () => {
  it("ends at a cycle, finding each reference once", () => {
    const a = node("a", ["b"], "p");
    const b = node("b", ["a"], "q");
    expect(reachedNames(binderOver([a, b, page("p"), page("q")]), a)).toEqual(["a.page->p", "b.page->q"]);
  });

  it("reads each declaration once, however many paths reach it", () => {
    // Ten layers of ten, each node naming every node of the next layer: the
    // paths through it number 10^10, the declarations 101.
    const layers = Array.from({ length: 10 }, (_, l) => Array.from({ length: 10 }, (_, i) => `n${l}_${i}`));
    const declarations = layers.flatMap((layer, l) =>
      layer.map((name) => node(name, l + 1 < layers.length ? layers[l + 1]! : [], "p")),
    );
    const root = node("root", layers[0]!);
    const counted = { sites: 0 };
    const walk = binderOver([root, ...declarations, page("p")], counted).reachable(root, root.kind, SPEC);
    expect(walk.ok && walk.references.length).toBe(100);
    expect(counted.sites).toBe(101);
  });

  it("does not walk a slot whose use is outside `through`", () => {
    const a = node("a", ["b"]);
    const b = node("b", [], "p");
    const walk = binderOver([a, b, page("p")]).reachable(a, a.kind, { ...SPEC, through: ["call"] });
    expect(walk).toEqual({ ok: true, references: [] });
  });

  it("fails on a hop naming a library's kind-only input", () => {
    const a = node("a", ["input"]);
    const input = node("input", [], undefined, { xTeloInjected: true });
    const walk = binderOver([a, input]).reachable(a, a.kind, SPEC);
    expect(walk).toMatchObject({ ok: false, failure: { reason: "kind-only", at: "next[0]" } });
  });
});
