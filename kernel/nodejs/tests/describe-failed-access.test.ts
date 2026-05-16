import { describe, expect, it } from "vitest";
import { describeFailedAccess } from "../src/evaluation-context.js";

describe("describeFailedAccess", () => {
  it("locates the missing key inside a nested object and reports the empty value", () => {
    const ctx = {
      steps: {
        call: { result: { result: {} } },
      },
    };
    const hint = describeFailedAccess(
      "steps.call.result.result.content[0].type",
      ctx,
      "No such key: content",
    );
    expect(hint).toBe(
      "at steps.call.result.result: cannot read 'content' — value is an empty object {}",
    );
  });

  it("lists available keys when the parent has other properties", () => {
    const ctx = {
      steps: {
        call: { result: { error: { code: -32004 } } },
      },
    };
    const hint = describeFailedAccess(
      "steps.call.result.content",
      ctx,
      "No such key: content",
    );
    expect(hint).toBe(
      "at steps.call.result: cannot read 'content' — available keys: error",
    );
  });

  it("reports when the parent is null", () => {
    const ctx = { steps: { call: { result: null } } };
    const hint = describeFailedAccess(
      "steps.call.result.content",
      ctx,
      "No such key: content",
    );
    expect(hint).toBe("at steps.call.result: cannot read 'content' — value is null");
  });

  it("reports when the parent is an array", () => {
    const ctx = { steps: { call: { result: [1, 2, 3] } } };
    const hint = describeFailedAccess(
      "steps.call.result.content",
      ctx,
      "No such key: content",
    );
    expect(hint).toBe(
      "at steps.call.result: cannot read 'content' — value is an array of length 3",
    );
  });

  it("returns null when the error is not a 'No such key' failure", () => {
    const ctx = { x: { y: 1 } };
    expect(describeFailedAccess("x.y", ctx, "Unknown variable: q")).toBeNull();
  });

  it("returns null when the source contains a function call or operator (bails safely)", () => {
    const ctx = { steps: { x: { result: {} } } };
    expect(
      describeFailedAccess(
        "steps.x.result.docs.orValue('')",
        ctx,
        "No such key: docs",
      ),
    ).toBeNull();
    expect(
      describeFailedAccess("a + b.c", ctx, "No such key: c"),
    ).toBeNull();
  });

  it("returns null when the failure key doesn't match the path tail", () => {
    const ctx = { a: { b: {} } };
    expect(describeFailedAccess("a.b.c", ctx, "No such key: z")).toBeNull();
  });

  it("handles bracket string-key access", () => {
    const ctx = { obj: { foo: {} } };
    const hint = describeFailedAccess('obj.foo["bar"]', ctx, "No such key: bar");
    expect(hint).toBe("at obj.foo: cannot read 'bar' — value is an empty object {}");
  });

  it("handles a missing intermediate key surfaced by CEL", () => {
    const ctx = { request: { params: { id: "abc" } } };
    const hint = describeFailedAccess(
      "request.body.payload",
      ctx,
      "No such key: body",
    );
    expect(hint).toBe(
      "at request: cannot read 'body' — available keys: params",
    );
  });
});
