import { isRefSentinel, makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { planInlineExtraction, planReferenceInlining } from "./inline-extraction";

const hostFields = {
  port: 8080,
  mounts: [
    { path: "/health", mount: { kind: "Http.Api", routes: [] } },
    {
      path: "/api/todos",
      mount: {
        kind: "Crud.Resource",
        plural: "todos",
        model: { kind: "Telo.JsonSchema", schema: { type: "object" } },
      },
    },
  ],
};

describe("planInlineExtraction", () => {
  it("takes the declaration's config, without kind or metadata", () => {
    const plan = planInlineExtraction(hostFields, "/mounts/1/mount", "todos")!;
    expect(plan.kind).toBe("Crud.Resource");
    expect(plan.config).toEqual({
      plural: "todos",
      // A nested inline declaration travels verbatim — extracting one level
      // does not flatten what is inside it.
      model: { kind: "Telo.JsonSchema", schema: { type: "object" } },
    });
  });

  it("leaves a reference in the slot", () => {
    const plan = planInlineExtraction(hostFields, "/mounts/1/mount", "todos")!;
    const slot = (plan.hostFields.mounts as { mount: unknown }[])[1].mount;
    expect(isRefSentinel(slot)).toBe(true);
    expect((slot as { source: string }).source).toBe("todos");
  });

  it("touches nothing else in the host", () => {
    const plan = planInlineExtraction(hostFields, "/mounts/1/mount", "todos")!;
    const mounts = plan.hostFields.mounts as { path: string; mount: unknown }[];
    expect(plan.hostFields.port).toBe(8080);
    expect(mounts[0]).toBe(hostFields.mounts[0]);
    expect(mounts[1].path).toBe("/api/todos");
    // The original is untouched — the caller diffs against it to write the AST.
    expect(hostFields.mounts[1].mount).toEqual({
      kind: "Crud.Resource",
      plural: "todos",
      model: { kind: "Telo.JsonSchema", schema: { type: "object" } },
    });
  });

  it("refuses a slot holding a reference rather than a declaration", () => {
    const fields = { mounts: [{ mount: { kind: "Http.Api", name: "api" } }] };
    expect(planInlineExtraction(fields, "/mounts/0/mount", "api2")).toBeNull();
  });

  it("refuses a pointer that names nothing", () => {
    expect(planInlineExtraction(hostFields, "/mounts/9/mount", "x")).toBeNull();
  });
});

const referencingHost = {
  port: 8080,
  mounts: [
    { path: "/health", mount: { kind: "Http.Api", routes: [] } },
    { path: "/api/todos", mount: makeTaggedSentinel("ref", "todos") },
  ],
};

const todos = {
  kind: "Crud.Resource",
  name: "todos",
  fields: {
    plural: "todos",
    connection: makeTaggedSentinel("ref", "db"),
  },
};

describe("planReferenceInlining", () => {
  it("writes the declaration into the slot, under its own kind", () => {
    const plan = planReferenceInlining(referencingHost, "/mounts/1/mount", todos)!;
    const mounts = plan.hostFields.mounts as { mount: unknown }[];
    expect(mounts[1].mount).toEqual({
      kind: "Crud.Resource",
      plural: "todos",
      // A reference the moved resource holds is carried, not resolved — moving
      // a declaration is not the same as flattening what it points at.
      connection: makeTaggedSentinel("ref", "db"),
    });
  });

  it("drops the name — the slot is where it lives now", () => {
    const plan = planReferenceInlining(referencingHost, "/mounts/1/mount", todos)!;
    const mounts = plan.hostFields.mounts as { mount: Record<string, unknown> }[];
    expect(mounts[1].mount.name).toBeUndefined();
  });

  it("touches nothing else in the host", () => {
    const plan = planReferenceInlining(referencingHost, "/mounts/1/mount", todos)!;
    const mounts = plan.hostFields.mounts as { path: string; mount: unknown }[];
    expect(plan.hostFields.port).toBe(8080);
    expect(mounts[0]).toBe(referencingHost.mounts[0]);
    expect(mounts[1].path).toBe("/api/todos");
    expect(referencingHost.mounts[1].mount).toEqual(makeTaggedSentinel("ref", "todos"));
  });

  it("refuses a slot that names a different resource", () => {
    expect(planReferenceInlining(referencingHost, "/mounts/1/mount", { ...todos, name: "other" }))
      .toBeNull();
  });

  it("refuses a slot holding a declaration rather than a reference", () => {
    expect(planReferenceInlining(referencingHost, "/mounts/0/mount", todos)).toBeNull();
  });

  it("round-trips with an extraction", () => {
    const extracted = planInlineExtraction(hostFields, "/mounts/1/mount", "todos")!;
    const folded = planReferenceInlining(extracted.hostFields, "/mounts/1/mount", {
      kind: extracted.kind,
      name: "todos",
      fields: extracted.config,
    })!;
    expect(folded.hostFields).toEqual(hostFields);
  });
});
