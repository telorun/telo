import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/environment.js";
import { environmentDigest } from "../src/environment-digest.js";

/**
 * What this engine judges about a namespaced call is **exactly what the host declared**, and
 * the two ways a host declares less are the subject here.
 *
 * A host's own signature grammar can be richer than CEL's — an optional trailing parameter, a
 * declared JSON Schema per parameter — and its name resolution can rest on vocabulary this
 * engine may not learn (an export gate, a capability, a re-export chain). Judging a call
 * against a declaration the host did not make leaves the host one move: suppress the verdict.
 * That is the after-the-fact classifier this engine exists to retire, so the engine declines
 * the question instead of answering it wrongly and being overruled.
 *
 * **The blind spot, written down:** these cases say what the engine does NOT report. They
 * cannot show that the host reports it instead — that is the host's own suite — so each case
 * also asserts the call is **LISTED**, which is the channel the host reads to report it. A
 * verdict withheld and not listed would be a verdict lost, and that is the failure this file
 * can see.
 */

const closed = () =>
  new CelEnvironment({ unlistedVariablesAreDyn: true }).registerNamespace("Alias", [
    "total(double, int): double",
  ]);

describe("an open namespace", () => {
  it("leaves a name it did not declare to the host: dyn, listed, reported by nobody", () => {
    const open = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerNamespace(
      "Alias",
      ["total(double, int): double"],
      { open: true },
    );
    const result = open.check("Alias.whatever(1, 'two')");
    expect(result.diagnostics).toEqual([]);
    expect(result.typeName).toBe("dyn");
    // Listed, so the host can resolve the name against its own vocabulary and word the verdict.
    expect(result.calls).toMatchObject([
      { name: "Alias.whatever", namespace: "Alias", arity: 2, form: "receiver" },
    ]);
  });

  it("still judges a name it DID declare", () => {
    const open = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerNamespace(
      "Alias",
      ["total(double, int): double"],
      { open: true },
    );
    expect(open.check("Alias.total(1.0, 2)").typeName).toBe("double");
    expect(open.check("Alias.total(1.0)").diagnostics[0]?.code).toBe("FUNCTION_ARITY_MISMATCH");
  });

  it("is not the default: a closed namespace refuses an undeclared name", () => {
    const result = closed().check("Alias.whatever(1)");
    expect(result.diagnostics[0]?.code).toBe("FUNCTION_UNRESOLVED");
    expect(result.calls).toHaveLength(1);
  });

  it("is per namespace, and re-registering closed again withdraws it", () => {
    const held = new CelEnvironment({ unlistedVariablesAreDyn: true })
      .registerNamespace("Open", [], { open: true })
      .registerNamespace("Closed", []);
    expect(held.check("Open.x()").diagnostics).toEqual([]);
    expect(held.check("Closed.x()").diagnostics[0]?.code).toBe("FUNCTION_UNRESOLVED");

    held.registerNamespace("Open", []);
    expect(held.check("Open.x()").diagnostics[0]?.code).toBe("FUNCTION_UNRESOLVED");
  });

  it("is inherited by a clone, which may then diverge", () => {
    const parent = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerNamespace(
      "Alias",
      [],
      { open: true },
    );
    const child = parent.clone();
    expect(child.check("Alias.x()").diagnostics).toEqual([]);
    child.registerNamespace("Alias", []);
    expect(child.check("Alias.x()").diagnostics[0]?.code).toBe("FUNCTION_UNRESOLVED");
    // The parent is untouched, as for every other registration.
    expect(parent.check("Alias.x()").diagnostics).toEqual([]);
  });

  it("changes the environment's digest, because it changes what checks clean", () => {
    const open = new CelEnvironment().registerNamespace("Alias", [], { open: true });
    const shut = new CelEnvironment().registerNamespace("Alias", []);
    expect(environmentDigest(open)).not.toBe(environmentDigest(shut));
  });
});

describe("a declaration that withholds its parameter list", () => {
  const withheld = () =>
    new CelEnvironment({ unlistedVariablesAreDyn: true }).registerNamespace("Alias", [
      { name: "total", returns: "double" },
    ]);

  it("types the call's result and judges neither its arity nor its arguments", () => {
    const held = withheld();
    for (const source of ["Alias.total()", "Alias.total(1.0, 2)", "Alias.total('a', 'b', 'c')"]) {
      const result = held.check(source);
      expect(result.diagnostics, source).toEqual([]);
      expect(result.typeName, source).toBe("double");
      // Listed with its arity, which is what lets the host judge what this engine did not.
      expect(result.calls, source).toHaveLength(1);
    }
    expect(held.check("Alias.total()").calls[0]?.arity).toBe(0);
    expect(held.check("Alias.total(1.0, 2)").calls[0]?.arity).toBe(2);
  });

  it("types an operator over the result, which is why the return type is declared at all", () => {
    expect(withheld().check("Alias.total(1) + 1.0").typeName).toBe("double");
    expect(withheld().check("Alias.total(1) + 'x'").diagnostics[0]?.code).toBe("CEL_TYPE_ERROR");
  });

  it("carries its flags exactly as a full signature does", () => {
    const held = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerNamespace("Alias", [
      { name: "clock", returns: "int", deterministic: false, hostBacked: true, throws: ["ERR_X"] },
    ]);
    expect(held.check("Alias.clock()").calls[0]).toMatchObject({
      deterministic: false,
      hostBacked: true,
      throws: ["ERR_X"],
    });
  });

  it("is listed by what it declares, never as a function of no arguments", () => {
    const listed = withheld().definitions().namespaces[0]!;
    expect(listed.functions).toEqual(["total(…): double"]);
    // A full declaration still prints its signature.
    expect(closed().definitions().namespaces[0]!.functions).toEqual([
      "total(double, int): double",
    ]);
  });

  it("takes a CelType as readily as its text", () => {
    const held = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerNamespace("Alias", [
      { name: "rows", returns: "list<string>" },
    ]);
    expect(held.check("Alias.rows()").typeName).toBe("list<string>");
    expect(held.check("Alias.rows()[0]").typeName).toBe("string");
  });
});
