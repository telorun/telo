/**
 * The catalog's declarations and its behaviour are two artifacts, and this is what holds
 * them to each other: every signature the data declares has exactly one implementation,
 * every implementation answers a signature the data declares, and every guard the data
 * claims exists. Without it the two drift in the one direction nothing else catches — a
 * declaration with no behaviour type-checks and then fails at evaluation.
 *
 * The catalog's own answers are not asserted here: the conformance rows pin every overload,
 * every refusal and every host handler's call, and a second set of cases would be a second
 * answer to the same question. What is proven here is only what no row can reach — the
 * agreement of the two artifacts, and the two seams the registration itself introduces.
 */
import { describe, expect, it } from "vitest";
import {
  catalogGuardedNames,
  catalogImplementation,
  catalogImplementedKeys,
  catalogSignatures,
  CelEnvironment,
  functionCatalog,
  parseSignature,
  registerFunctionCatalog,
  signatureKey,
} from "../src/index.js";

const keysDeclared = (): readonly string[] =>
  catalogSignatures().map((signature) => signatureKey(parseSignature(signature)));

describe("the function catalog", () => {
  it("implements every signature it declares", () => {
    const missing = keysDeclared().filter((key) => catalogImplementation(key, {}) === undefined);
    expect(missing).toEqual([]);
  });

  it("implements nothing it does not declare", () => {
    const declared = new Set(keysDeclared());
    expect(catalogImplementedKeys().filter((key) => !declared.has(key))).toEqual([]);
  });

  it("guards exactly the functions the data says check their literal arguments", () => {
    const claimed = functionCatalog()
      .filter((entry) => entry.checksLiteralArguments)
      .map((entry) => entry.name);
    expect([...catalogGuardedNames()].sort()).toEqual([...claimed].sort());
  });

  it("answers a host-backed call with no handler by naming the function", () => {
    const environment = new CelEnvironment();
    registerFunctionCatalog(environment);
    expect(() => environment.evaluate("sha256('abc')")).toThrow(
      /sha256\(\) is supplied by the host/,
    );
    const supplied = new CelEnvironment();
    registerFunctionCatalog(supplied, { handlers: { sha256: (text) => `hashed:${text}` } });
    expect(supplied.evaluate("sha256('abc')")).toBe("hashed:abc");
  });

  it("refuses an argument written as a literal at CHECK, naming the call as written", () => {
    const environment = new CelEnvironment({ unlistedVariablesAreDyn: true });
    registerFunctionCatalog(environment);
    const refused = environment.check("1 + size(fixed(1.0, 11))");
    expect(refused.diagnostics.map((held) => [held.code, held.message, held.range])).toEqual([
      [
        "CEL_INVALID_ARGUMENT",
        "fixed: decimal places must be an integer 0-10, got 11 (in `fixed(1.0, 11)`)",
        [9, 23],
      ],
    ]);
    // A computed argument is not judged: the guard is handed `undefined` for it, and the
    // same refusal is the evaluation's where the value turns out to be the same one.
    expect(environment.check("fixed(1.0, digits)").diagnostics).toEqual([]);
  });
});
