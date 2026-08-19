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

  it("rejects `false`, a number and a list", () => {
    for (const value of [false, 1, ["/connection"]]) {
      expect(messages(withSlot({ "x-telo-provides-zone": value }))).toHaveLength(1);
    }
  });
});

describe("validate-zone-slots — zone attributes", () => {
  it("accepts the object form, with and without a correlation key", () => {
    expect(
      messages(
        withSlot({
          "x-telo-provides-zone": {
            key: "/connection",
            atomic: "a rollback erases writes a journal recorded as done",
            noSuspend: "the transaction holds a connection a parked run would lose",
          },
        }),
      ),
    ).toEqual([]);
    expect(
      messages(
        withSlot({ "x-telo-provides-zone": { noSuspend: "the lease lapses unrenewed" } }),
      ),
    ).toEqual([]);
  });

  it("reads the attributes back off the accepted form", () => {
    const slot = readProvidesZone({
      "x-telo-provides-zone": { key: "/connection", noSuspend: "the connection would be gone" },
    });
    expect(slot).toEqual({
      key: "/connection",
      attributes: { noSuspend: "the connection would be gone" },
    });
    // The two scalar spellings say nothing about their contents, so a consumer
    // reading attributes off one gets an empty record rather than undefined.
    expect(readProvidesZone({ "x-telo-provides-zone": true })).toEqual({ attributes: {} });
  });

  it("names the closed vocabulary and suggests a spelling for an unknown attribute", () => {
    const found = messages(
      withSlot({ "x-telo-provides-zone": { noSuspemd: "one character out" } }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/Did you mean 'noSuspend'/);
    expect(found[0]).toMatch(/atomic, idempotent, noSuspend, replayed/);
  });

  it("enforces `requires:` from the vocabulary entry, not from a pair of names in code", () => {
    const found = messages(
      withSlot({ "x-telo-provides-zone": { atomic: "a rollback erases the entries too" } }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/declares 'atomic' without 'noSuspend'/);
  });

  it("rejects a boolean value — the value IS the reason, so there is no `true` to accept", () => {
    const found = messages(withSlot({ "x-telo-provides-zone": { noSuspend: true } }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/author's REASON/);
    // And the reader drops it, so no consumer sees an attribute with nothing to
    // quote — the degrade the diagnostic above is what makes visible.
    expect(
      readProvidesZone({ "x-telo-provides-zone": { noSuspend: true } })?.attributes,
    ).toEqual({});
  });

  it("refuses the whole annotation when a present `key` is unreadable", () => {
    // Same reason the scalar spelling refuses one: the kernel's walk resolves a
    // bare name while this reader drops it, so the halves would disagree about
    // what the manifest means.
    expect(
      readProvidesZone({ "x-telo-provides-zone": { key: "connection", noSuspend: "held" } }),
    ).toBeUndefined();
    expect(
      messages(withSlot({ "x-telo-provides-zone": { key: "connection", noSuspend: "held" } })),
    ).toHaveLength(1);
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
