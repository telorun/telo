import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { refuseUndeclarableCapability } from "../src/controllers/resource-definition/kind-document-guard.js";
import { createKindDocument } from "./create-kind-document.js";

/** A `capability:` names a lifecycle role a kernel implements — the closed
 *  roster of the built-in entries — and a `Telo.Definition` / `Telo.Abstract`
 *  is held, where every resource is created, to the built-in entry's one
 *  schema. The roster is judged first, so a mistaken capability is one error
 *  naming the role vocabulary. The pair with `telo check` is pinned by
 *  `tests/check-run-agreement.yaml`; the refusals' text by the vectors every
 *  runtime answers (`analyzer/capability-conformance/`). */
const CAPABILITY_VECTORS = JSON.parse(
  readFileSync(
    new URL("../../../analyzer/capability-conformance/vectors.json", import.meta.url),
    "utf-8",
  ),
).rows as Array<{
  id: string;
  capability?: unknown;
  extends: boolean;
  code: string | null;
  message: string | null;
}>;

describe("the capability roster at registration", () => {
  const refusal = (doc: Record<string, unknown>) => {
    try {
      refuseUndeclarableCapability(doc);
      return undefined;
    } catch (err) {
      const { code, message } = err as { code?: string; message?: string };
      return { code, message };
    }
  };

  it("answers every capability conformance vector, on a definition and an abstract", () => {
    for (const row of CAPABILITY_VECTORS) {
      for (const kind of ["Telo.Definition", "Telo.Abstract"]) {
        const doc: Record<string, unknown> = { kind, metadata: { name: "Thing" } };
        if (Object.hasOwn(row, "capability")) doc.capability = row.capability;
        if (row.extends) doc.extends = "Lib.Base";
        expect(refusal(doc), `${kind} ${row.id}`).toEqual(
          row.code === null
            ? undefined
            : { code: `ERR_${row.code}`, message: `${kind} 'Thing': ${row.message}` },
        );
      }
    }
  });
});

describe("the Telo.Definition schema at registration", () => {
  it("refuses a field it does not declare", async () => {
    const thing = {
      kind: "Telo.Definition",
      metadata: { name: "Thing" },
      capability: "Telo.Type",
      schema: { type: "object" },
    };
    expect(await createKindDocument(thing)).toBeUndefined();
    const refused = await createKindDocument({ ...thing, controllrs: [] });
    expect(refused?.code).toBe("ERR_RESOURCE_SCHEMA_VALIDATION_FAILED");
    expect(refused?.message).toContain("controllrs");
  });
});
