import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { readProvidesZone, readRequiresZone } from "../src/zone-slot.js";
import { validateZoneSlotDeclarations } from "../src/validate-zone-slots.js";

/** A definition whose one slot carries the given annotations. */
function withSlot(annotations: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Thing", module: "test" },
    capability: "Telo.Invocable",
    schema: { type: "object", properties: { slot: { ...annotations } } },
  } as unknown as ResourceManifest;
}

const messages = (m: ResourceManifest): string[] =>
  validateZoneSlotDeclarations(m).map((i) => i.message);

describe("validate-zone-slots — x-telo-provides-zone", () => {
  it("accepts `true` and a self-relative pointer", () => {
    expect(messages(withSlot({ "x-telo-provides-zone": true }))).toEqual([]);
    expect(messages(withSlot({ "x-telo-provides-zone": "/connection" }))).toEqual([]);
  });

  it("rejects a bare field name — the reader drops it, so the slot would never discharge", () => {
    const found = messages(withSlot({ "x-telo-provides-zone": "connection" }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/JSON Pointer/);
    // Left unreported this is worse than a no-op: the provider stops
    // discharging, so the pass invents ZONE_REQUIREMENT_UNSATISFIED on
    // manifests that are correct.
    expect(readProvidesZone({ "x-telo-provides-zone": "connection" })).toBeUndefined();
  });

  it("rejects `false`, a number and an object", () => {
    for (const value of [false, 1, { key: "/connection" }]) {
      expect(messages(withSlot({ "x-telo-provides-zone": value }))).toHaveLength(1);
    }
  });
});

describe("validate-zone-slots — x-telo-requires-zone", () => {
  it("accepts the bare-kind form and the full object form", () => {
    expect(messages(withSlot({ "x-telo-requires-zone": "Self.Transaction" }))).toEqual([]);
    expect(
      messages(
        withSlot({
          "x-telo-requires-zone": {
            zone: "Self.Transaction",
            key: ["/connection", "/transaction/connection"],
            reason: "the statement would execute outside any transaction",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("rejects an object with no `zone` — the requirement would be silently unenforced", () => {
    const annotation = { "x-telo-requires-zone": { key: "/connection" } };
    const found = messages(withSlot(annotation));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/declares no 'zone'/);
    // The reader drops it entirely, so without this check nothing statically
    // reports it and the resource throws at dispatch instead.
    expect(readRequiresZone(annotation)).toBeUndefined();
  });

  it("rejects a key that is not a pointer, where the two halves would disagree", () => {
    // The kernel's walk splits on `/` and drops empty segments, so a bare name
    // RESOLVES there while the checker skips it: the analyzer would call the
    // requirement uncorrelated and the runtime would enforce a correlation.
    const found = messages(
      withSlot({ "x-telo-requires-zone": { zone: "Self.Tx", key: "connection" } }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/disagree about what this manifest means/);
  });

  it("applies the pointer rule to the scalar form as well as the list", () => {
    // The reader used to filter only the list form, which is what let the
    // scalar through to diverge.
    expect(readRequiresZone({ "x-telo-requires-zone": { zone: "Self.Tx", key: "connection" } })?.key)
      .toEqual([]);
    expect(readRequiresZone({ "x-telo-requires-zone": { zone: "Self.Tx", key: "/connection" } })?.key)
      .toEqual(["/connection"]);
  });

  it("rejects an unknown property and a non-string reason", () => {
    expect(
      messages(withSlot({ "x-telo-requires-zone": { zone: "Self.Tx", correlate: "connection" } })),
    ).toHaveLength(1);
    expect(
      messages(withSlot({ "x-telo-requires-zone": { zone: "Self.Tx", reason: 42 } })),
    ).toHaveLength(1);
  });

  it("reports the schema path of the offending slot", () => {
    const issues = validateZoneSlotDeclarations(withSlot({ "x-telo-provides-zone": "nope" }));
    expect(issues[0]!.path).toBe("schema.properties.slot");
  });

  it("finds annotations nested behind $defs", () => {
    const nested = {
      kind: "Telo.Definition",
      metadata: { name: "Nested", module: "test" },
      schema: {
        type: "object",
        $defs: { step: { properties: { slot: { "x-telo-provides-zone": "bad" } } } },
        properties: { steps: { items: { $ref: "#/$defs/step" } } },
      },
    } as unknown as ResourceManifest;
    expect(validateZoneSlotDeclarations(nested)).toHaveLength(1);
  });
});
