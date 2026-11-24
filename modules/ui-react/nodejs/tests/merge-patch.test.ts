import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergePatchOf } from "../src/browser/merge-patch.js";
import { Validators } from "../src/browser/validators.js";

type Step = { answered: { method: string; path: string; status: number; etag?: string } } | { request: { method: string; path: string }; ifMatch?: string };
type Row =
  | { name: string; kind: "patch"; properties: string[]; start: Record<string, unknown>; entered: Record<string, unknown>; patch: Record<string, unknown> }
  | { name: string; kind: "precondition"; steps: Step[] };

/** `ui`'s conformance rows: the merge patch an edit form sends and the `If-Match` a write carries. */
const { rows } = JSON.parse(readFileSync(new URL("../../../ui/conformance/merge-patch.json", import.meta.url), "utf8")) as { rows: Row[] };

describe("the merge-patch conformance rows", () => {
  for (const row of rows) {
    it(row.name, () => {
      if (row.kind === "patch") return expect(mergePatchOf(row.properties, row.start, row.entered)).toEqual(row.patch);
      const validators = new Validators();
      for (const step of row.steps) {
        if ("answered" in step) validators.answered(step.answered.method, step.answered.path, step.answered.status, step.answered.etag);
        else expect(validators.ifMatch(step.request.method, step.request.path)).toBe(step.ifMatch);
      }
    });
  }
});

describe("the kept validators", () => {
  it("drop the least recently used path past their bound", () => {
    const validators = new Validators(2);
    validators.answered("GET", "/api/tasks/1", 200, '"a"');
    validators.answered("GET", "/api/tasks/2", 200, '"b"');
    expect(validators.ifMatch("PATCH", "/api/tasks/1")).toBe('"a"');
    validators.answered("GET", "/api/tasks/3", 200, '"c"');
    expect(validators.ifMatch("PATCH", "/api/tasks/2")).toBeUndefined();
    expect(validators.ifMatch("PATCH", "/api/tasks/1")).toBe('"a"');
    expect(validators.ifMatch("PATCH", "/api/tasks/3")).toBe('"c"');
  });
});
