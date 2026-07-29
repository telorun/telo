import { describe, expect, it } from "vitest";
import { makeTaggedSentinel } from "@telorun/templating";
import type { ResourceInstance } from "@telorun/sdk";
import { ResourceContextImpl } from "../src/resource-context.js";

/**
 * `ResourceContext.resolveRef` has to do two things the raw resolver cannot, and
 * both are what let a `with:`-scoped resource reference a scoped sibling:
 *
 *  - Rescue a `!ref` that reaches the controller as the raw SENTINEL. Phase-5
 *    injection is field-map-driven and the field map does not descend into the
 *    inline declarations inside an `x-telo-scope` array, so a scoped resource's
 *    ref slot is not an injection site; Phase 2.5 rewrites the sentinel only when
 *    it can name a target, so both shapes reach the controller.
 *  - Resolve a bare name SCOPE-LOCAL FIRST, enclosing module as the fallback —
 *    the order `ScopeContext.getInstance` and the CEL `resources` layering
 *    already use, so `!ref` and CEL never disagree about what a name means
 *    inside a scope.
 */
interface Named extends ResourceInstance {
  readonly from: string;
}

const isNamed = (value: unknown): value is Named =>
  typeof (value as Named | undefined)?.from === "string";

/** A context stub shaped like the slice `resolveRef` touches: a name→instance map
 *  standing in for an `EvaluationContext`'s `resourceInstances`. */
function contextOf(instances: Record<string, Named>) {
  return {
    resourceInstances: new Map(
      Object.entries(instances).map(([name, instance]) => [
        name,
        { instance, resource: { kind: "Test.Thing", metadata: { name } } },
      ]),
    ),
    getInstance: (name: string) => instances[name],
    resolveImportedInstance: () => undefined,
    resolveImportedRef: () => undefined,
  };
}

/** `owning` is the per-run scope child for a `with:`-scoped resource; omitting it
 *  models a top-level resource, whose owning context IS the module. */
function resourceContext(module: Record<string, Named>, owning?: Record<string, Named>) {
  const moduleContext = contextOf(module);
  return new ResourceContextImpl(
    { resourceKindByName: () => "Test.Thing" } as never,
    moduleContext as never,
    { name: "user" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "",
    (owning ? contextOf(owning) : moduleContext) as never,
  );
}

const describeSlot = () => 'Test.User "user": \'thing\'';
const resolvedRef = { kind: "Test.Thing", name: "target" };
const sentinel = makeTaggedSentinel("ref", "target");

describe("ResourceContext.resolveRef", () => {
  it("rescues a raw !ref sentinel the scope left unrewritten", () => {
    const ctx = resourceContext({}, { target: { from: "scope" } });
    expect(ctx.resolveRef(sentinel, isNamed, describeSlot).from).toBe("scope");
  });

  it("prefers a scope-local instance over an outer one of the same name", () => {
    const ctx = resourceContext({ target: { from: "outer" } }, { target: { from: "scope" } });
    expect(ctx.resolveRef(resolvedRef, isNamed, describeSlot).from).toBe("scope");
    // …and by the same rule when it arrives as a sentinel.
    expect(ctx.resolveRef(sentinel, isNamed, describeSlot).from).toBe("scope");
  });

  it("falls back to the enclosing module for a name the scope does not declare", () => {
    const ctx = resourceContext({ target: { from: "outer" } }, { other: { from: "scope" } });
    expect(ctx.resolveRef(resolvedRef, isNamed, describeSlot).from).toBe("outer");
  });

  it("resolves against the module for a top-level resource, which owns no scope", () => {
    const ctx = resourceContext({ target: { from: "outer" } });
    expect(ctx.resolveRef(resolvedRef, isNamed, describeSlot).from).toBe("outer");
  });

  it("passes a Phase-5-injected instance straight through", () => {
    const injected: Named = { from: "injected" };
    const ctx = resourceContext({ target: { from: "outer" } });
    expect(ctx.resolveRef(injected, isNamed, describeSlot).from).toBe("injected");
  });

  it("still reports an unresolvable name rather than returning undefined", () => {
    const ctx = resourceContext({}, {});
    expect(() => ctx.resolveRef(resolvedRef, isNamed, describeSlot, "Test.Thing")).toThrow(
      /did not resolve to a resource satisfying `Test.Thing`/,
    );
  });
});
