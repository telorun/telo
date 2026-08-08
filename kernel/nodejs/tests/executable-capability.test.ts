import { describe, expect, it } from "vitest";
import { validateResourceDefinition } from "../src/manifest-schemas.js";

/** `Telo.Executable` is a slot constraint — the parent of `Telo.Invocable` and
 *  `Telo.Runnable` in `x-telo-ref` acceptance — and names no lifecycle role, so
 *  declaring it as a definition's `capability:` must be rejected. It is listed
 *  in `KNOWN_CAPABILITIES` precisely so the open third-party fallback branch
 *  cannot admit it. */
describe("capability: Telo.Executable is not declarable", () => {
  const definition = (capability: string) => ({
    kind: "Telo.Definition",
    metadata: { name: "Thing" },
    capability,
    schema: { type: "object", properties: {} },
  });

  it("accepts the executable leaf capabilities", () => {
    expect(validateResourceDefinition(definition("Telo.Invocable"))).toBe(true);
    expect(validateResourceDefinition(definition("Telo.Runnable"))).toBe(true);
  });

  it("rejects the slot-constraint parent", () => {
    expect(validateResourceDefinition(definition("Telo.Executable"))).toBe(false);
  });

  it("names the mistake at create() instead of an anonymous oneOf failure", async () => {
    const { create } = await import(
      "../src/controllers/resource-definition/resource-definition-controller.js"
    );
    await expect(
      create(definition("Telo.Executable"), {} as never),
    ).rejects.toThrow(/Telo\.Executable.*slot constraint.*Telo\.Invocable/s);
  });

  it("still accepts an unknown capability — the third-party extension branch", () => {
    expect(validateResourceDefinition(definition("Custom.Lifecycle"))).toBe(true);
  });
});
