/**
 * The library's declarations and its behaviour are two artifacts, and this is what holds
 * them to each other: every signature a default environment registers has exactly one
 * implementation, and every implementation answers a signature something registers.
 *
 * Without it the two drift in the one direction nothing else catches — a declaration with
 * no behaviour type-checks and then fails at evaluation, which is the failure class the
 * whole engine exists to remove.
 */
import { describe, expect, it } from "vitest";
import {
  CALL_SITE_DIRECT_ARITY,
  CelEnvironment,
  FunctionRegistry,
  implementationOf,
  implementedKeys,
  registerStandardLibrary,
  signatureKey,
} from "../src/index.js";

/**
 * The library as the registry holds it. An operator's signature (`!(bool): bool`) is not
 * spelled as a name, so the registrations are read as objects rather than re-parsed from
 * the text a listing prints.
 */
function registered(): FunctionRegistry {
  const registry = new FunctionRegistry();
  registerStandardLibrary(registry, { optionalTypes: true });
  return registry;
}

describe("the runtime library", () => {
  it("implements every signature the standard library registers", () => {
    const missing = registered()
      .list()
      .filter((held) => implementationOf(held.signature) === undefined)
      .map((held) => signatureKey(held.signature));
    expect(missing).toEqual([]);
  });

  it("implements nothing the standard library does not register", () => {
    const keys = new Set(registered().list().map((held) => signatureKey(held.signature)));
    expect(implementedKeys().filter((key) => !keys.has(key))).toEqual([]);
  });

  it("leaves a host's own function to the host, and fails a call to one with no behaviour", () => {
    const environment = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerFunction(
      "hostOnly(string): string",
      { hostBacked: true },
    );
    expect(() => environment.evaluate("hostOnly('x')")).toThrow(/unbound|no overload/);
    environment.registerFunction("hostOnly(string): string", {
      implementation: (ctx, a) => `${a as string}!`,
    });
    expect(environment.evaluate("hostOnly('x')")).toBe("x!");
  });

  it("refuses a signature wider than an implementation receives, where it is registered", () => {
    // An implementation takes its arguments positionally, so a signature past the bound could
    // only be called with its tail dropped. Refusing it at REGISTRATION is what keeps that
    // from being a silently wrong answer: the bound is declared, so it is also enforced.
    const environment = new CelEnvironment({ unlistedVariablesAreDyn: true });
    const widest = Array.from({ length: CALL_SITE_DIRECT_ARITY }, () => "int").join(", ");
    const wider = Array.from({ length: CALL_SITE_DIRECT_ARITY + 1 }, () => "int").join(", ");
    expect(() => environment.registerFunction(`widest(${widest}): int`)).not.toThrow();
    expect(() => environment.registerFunction(`wider(${wider}): int`)).toThrow(
      /takes 5 values and an implementation receives at most 4/,
    );
    // The receiver counts toward the arity, because dispatch resolves on it.
    expect(() => environment.registerFunction(`int.widest(${widest}): int`)).toThrow(
      /takes 5 values/,
    );
    // And a call written wider than any signature may be is still an ordinary refusal,
    // naming the types it was handed, rather than a crash in the backend that wrote it.
    const refused = (source: string) => {
      try {
        environment.evaluate(source);
        return "no refusal";
      } catch (cause) {
        return (cause as { code?: string }).code ?? (cause as Error).name;
      }
    };
    expect(refused("'42'.replace('2', '1', 1, false)")).toBe("no_matching_overload");
    expect(refused("size(1, 2, 3, 4, 5)")).toBe("no_matching_overload");
  });
});
