/**
 * The closure backend's own properties: how a namespaced call is dispatched, and that
 * compiling reaches no code generator and no filesystem.
 *
 * The second one is a property of the SOURCE, so it is read from the source: `eval` and
 * `new Function` are unavailable under a content-security policy and in several of the
 * hosts Telo targets, and a backend that quietly used one would pass every behavioural
 * test and fail on the platform it was forbidden on.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALL_SITE_CACHE_CAPACITY,
  CelEnvironment,
  DEFAULT_COMPILED_CACHE_CAPACITY,
  PATTERN_CACHE_CAPACITY,
  type CelValue,
} from "../src/index.js";

const source = join(import.meta.dirname, "..", "src");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(directory, entry.name)]
        : [],
  );
}

describe("the closure backend", () => {
  it("dispatches a namespaced call through what the host bound, and fails where nothing did", () => {
    const environment = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerNamespace(
      "Billing",
      ["total(int, int): int"],
    );
    const program = environment.compile("Billing.total(2, 3) + 1");
    const dispatched: CelValue[][] = [];
    const answered = program.evaluate(
      {},
      {
        namespaceFunction: (namespace, name) =>
          namespace === "Billing" && name === "total"
            ? (args) => {
                dispatched.push([...args]);
                return (args[0] as bigint) * (args[1] as bigint);
              }
            : undefined,
      },
    );
    expect(answered).toBe(7n);
    expect(dispatched).toEqual([[2n, 3n]]);
    expect(() => program.evaluate({})).toThrow(/unbound function 'Billing.total'/);
  });

  it("reaches no code generator and no filesystem", () => {
    const forbidden = /\bnew Function\b|[^.\w]eval\(|from "node:|require\(/;
    const offenders = sources(source).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        // A line of prose may name what the code must not do, as this file's own does.
        .filter((line) => !/^\s*(\*|\/\/)/.test(line) && forbidden.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("declares the capacity of every cache it keeps", () => {
    for (const capacity of [
      CALL_SITE_CACHE_CAPACITY,
      DEFAULT_COMPILED_CACHE_CAPACITY,
      PATTERN_CACHE_CAPACITY,
    ]) {
      expect(Number.isInteger(capacity) && capacity > 0).toBe(true);
    }
  });
});
