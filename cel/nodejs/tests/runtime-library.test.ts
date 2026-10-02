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
      implementation: (args) => `${args[0] as string}!`,
    });
    expect(environment.evaluate("hostOnly('x')")).toBe("x!");
  });
});
