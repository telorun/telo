import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { offeredValueTags, tagOf, tagSourceOf } from "./value-tag";

const ids = (prop: Record<string, unknown>, evalMode: "compile" | "runtime" | null) =>
  offeredValueTags(prop, evalMode).map((o) => o.id);

describe("offeredValueTags", () => {
  it("offers the slot-typed tags only where the field is CEL-eligible", () => {
    // Outside an eval field the value would never be evaluated — which the
    // analyzer reports as CEL_IN_NON_EVAL_FIELD.
    expect(ids({ type: "string" }, "compile")).toContain("cel");
    expect(ids({ type: "string" }, "compile")).toContain("literal");
    expect(ids({ type: "string" }, null)).not.toContain("cel");
    expect(ids({ type: "string" }, null)).not.toContain("literal");
  });

  it("offers an embed where its produced type satisfies the slot", () => {
    expect(ids({ type: "string" }, null)).toEqual(["include-text"]);
    expect(ids({ "x-telo-type": "Telo.Bytes" }, null)).toEqual(["include-bytes"]);
  });

  it("keeps a byte embed off a string slot and text off a byte slot", () => {
    // The property the produced-type seam exists to give, checked with the
    // analyzer's own comparator rather than a second rule here.
    expect(ids({ type: "string" }, null)).not.toContain("include-bytes");
    expect(ids({ "x-telo-type": "Telo.Bytes" }, null)).not.toContain("include-text");
  });

  it("offers both embeds at a slot that declares no type", () => {
    // An undeclared slot constrains nothing, so nothing about the value can
    // contradict it.
    expect(ids({}, null).sort()).toEqual(["include-bytes", "include-text"]);
  });

  it("never offers `ref` or `sql`", () => {
    // `!ref` names a resource rather than producing a value, and a ref slot is
    // dispatched to the reference picker long before this. `!sql` has no widget
    // until the renderer consumes `engine.language`.
    const everywhere = [...ids({}, "runtime"), ...ids({ type: "string" }, "compile")];
    expect(everywhere).not.toContain("ref");
    expect(everywhere).not.toContain("sql");
  });

  it("describes every tag it offers", () => {
    for (const option of offeredValueTags({ type: "string" }, "compile")) {
      expect(option.label.startsWith("!")).toBe(true);
      expect(option.hint.length).toBeGreaterThan(0);
      expect(["expression", "path"]).toContain(option.editor);
    }
  });
});

describe("reading a written value", () => {
  it("reports the tag and its source", () => {
    const value = makeTaggedSentinel("cel", "variables.port");
    expect(tagOf(value)).toBe("cel");
    expect(tagSourceOf(value)).toBe("variables.port");
  });

  it("reads a raw `${{ }}` string as UNTAGGED, because that is what it is", () => {
    // It is the spelling manifests must never carry — the formatter rewrites it
    // and the round trip has mangled it into a broken `!ref`. Showing it as
    // untagged is what lets the picker offer to write the tag.
    expect(tagOf("${{ variables.port }}")).toBeNull();
    expect(tagSourceOf("${{ variables.port }}")).toBe("${{ variables.port }}");
  });

  it("reports no source for a non-string plain value", () => {
    expect(tagOf(8080)).toBeNull();
    expect(tagSourceOf(8080)).toBe("");
  });
});
