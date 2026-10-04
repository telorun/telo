/**
 * What identifies an entry of a map, and that the ways a map is built agree about it.
 *
 * Entries live in a `Map` keyed by each key's own typed value, so the four CEL key types
 * separate themselves: a `Map` compares a key by type as well as by value, and that is what
 * replaced a `s`/`n`/`b` prefix built per key. The guarantees the prefix carried are what
 * this holds the typed key to, each stated as a check rather than assumed:
 *
 * - one container holds int, uint, bool and string keys;
 * - `1`, `1u` and `1.0` are ONE key, and a string `"1"` is a different key;
 * - a key is never a property name, so `__proto__` round-trips as data;
 * - a double that is not whole names no entry, and no map is BUILT with one.
 *
 * A literal, a comprehension and `parseJson` build a map by three different paths, so each
 * is asked the same questions — the conformance replay covers the literal, and the other two
 * are where a reading of "what identifies a key" could have diverged unnoticed.
 */
import { describe, expect, it } from "vitest";
import {
  CelEnvironment,
  CelEvaluationError,
  isCelMap,
  registerFunctionCatalog,
  type CelValue,
} from "../src/index.js";

const base = () =>
  new CelEnvironment({ unlistedVariablesAreDyn: true, homogeneousAggregateLiterals: false });

const withCatalog = () => {
  const environment = base();
  registerFunctionCatalog(environment, { handlers: {} });
  return environment;
};

/** The code an evaluation refused with, which is what is decided where the cause is known. */
function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (cause) {
    if (cause instanceof CelEvaluationError) return { code: cause.code, message: cause.message };
    return { code: `threw ${(cause as Error).name}`, message: (cause as Error).message };
  }
  return { code: "no refusal", message: "" };
}

const MIXED = "{'1': 'text', 1: 'int', 2u: 'uint', true: 'bool'}";

describe("a map's key identity", () => {
  it("holds CEL's four key types in one container, each a key of its own", () => {
    const environment = base();
    expect(isCelMap(environment.evaluate(MIXED))).toBe(true);
    expect(environment.evaluate(`size(${MIXED})`)).toBe(4n);
    for (const [read, expected] of [
      [`${MIXED}['1']`, "text"],
      [`${MIXED}[1]`, "int"],
      [`${MIXED}[2u]`, "uint"],
      [`${MIXED}[true]`, "bool"],
      // The numeric types are ONE key, reached by any of the three spellings.
      [`${MIXED}[1u]`, "int"],
      [`${MIXED}[1.0]`, "int"],
      [`${MIXED}[2]`, "uint"],
      [`${MIXED}[2.0]`, "uint"],
    ] as const) {
      expect(environment.evaluate(read), read).toBe(expected);
    }
    // And a string key is never the numeric one, whichever way round it is asked.
    expect(refusal(() => environment.evaluate("{'1': 'text'}[1]")).code).toBe("no_such_key");
    expect(refusal(() => environment.evaluate("{1: 'int'}['1']")).code).toBe("no_such_key");
    expect(refusal(() => environment.evaluate("{true: 1}['true']")).code).toBe("no_such_key");
    expect(refusal(() => environment.evaluate("{'true': 1}[true]")).code).toBe("no_such_key");
  });

  it("refuses a key of a type no map is keyed by, and a double that is not whole", () => {
    const environment = base();
    for (const source of ["{1.5: 'x'}", "{[1]: 'x'}", "{{'a': 1}: 'x'}"]) {
      const held = refusal(() => environment.evaluate(source));
      expect(held.code, source).toBe("unsupported_key_type");
      expect(held.message, source).toBe("a map is keyed by an int, a uint, a bool or a string");
    }
    // A whole double still LOOKS one up — `{1: 'x'}[?1.0]` reads the entry — while a double
    // that is not whole is a mistake in the READ rather than an absent entry, because no key
    // of any type could have been the one asked for. (Verified unchanged against the build
    // from before the typed key.)
    expect(environment.evaluate("{1: 'x'}[?1.0]")).toMatchObject({ present: true });
    expect(refusal(() => environment.evaluate("{1: 'x'}[?3.1]")).code).toBe("unsupported_key_type");
    expect(environment.evaluate("{1: 'x'}[?2]")).toMatchObject({ present: false });
  });

  it("refuses two keys CEL equality makes one, naming the key written twice", () => {
    const environment = base();
    for (const [source, named] of [
      ["{1: 'a', 1u: 'b'}", "the key 1u is written twice"],
      ["{1u: 'a', 1: 'b'}", "the key 1 is written twice"],
      ["{'k': 1, 'k': 2}", 'the key "k" is written twice'],
      ["{true: 1, true: 2}", "the key true is written twice"],
    ] as const) {
      const held = refusal(() => environment.evaluate(source));
      expect(held.code, source).toBe("duplicate_map_key");
      expect(held.message, source).toBe(named);
    }
  });

  it("keeps a key that names a prototype member as data, in every form of read", () => {
    const environment = base();
    for (const key of ["__proto__", "constructor", "prototype", "toString", "valueOf"]) {
      const literal = `{'${key}': 7}`;
      expect(environment.evaluate(`${literal}['${key}']`), literal).toBe(7n);
      expect(environment.evaluate(`${literal}.\`${key}\``), literal).toBe(7n);
      expect(environment.evaluate(`size(${literal})`), literal).toBe(1n);
      expect(environment.evaluate(`'${key}' in ${literal}`), literal).toBe(true);
      // A map that does NOT hold it answers a missing key, never what a prototype would.
      expect(refusal(() => environment.evaluate(`{'a': 1}['${key}']`)).code, key).toBe("no_such_key");
      expect(environment.evaluate(`'${key}' in {'a': 1}`), key).toBe(false);
    }
  });

  it("answers the same questions for a map a comprehension ranged over or built", () => {
    const environment = base();
    // A comprehension ranges over the KEYS, so a key's identity decides what it iterates.
    expect(environment.evaluate(`size(${MIXED}.map(k, k))`)).toBe(4n);
    expect(environment.evaluate("{1: 'a', 2u: 'b'}.map(k, k).size()")).toBe(2n);
    // The keys come back as the values they are, so each reads its own entry again.
    expect(environment.evaluate("{1: 'a', 2u: 'b'}.map(k, {1: 'a', 2u: 'b'}[k])")).toEqual([
      "a",
      "b",
    ]);
    // A map built AROUND a comprehension's result answers by the same identity.
    expect(environment.evaluate("{1: [1, 2].map(e, e * 2)}[1u]")).toEqual([2n, 4n]);
    expect(environment.evaluate("{'1': 'text', 1: 'int'}.map(k, k).size()")).toBe(2n);
  });

  it("answers the same questions for a map parseJson built", () => {
    const environment = withCatalog();
    // JSON gives string keys only, which is the path that could carry no prefix at all.
    expect(environment.evaluate(`parseJson('{"a": 1, "__proto__": 2}')['__proto__']`)).toBe(2);
    expect(environment.evaluate(`size(parseJson('{"a": 1, "b": 2}'))`)).toBe(2n);
    expect(environment.evaluate(`'a' in parseJson('{"a": 1}')`)).toBe(true);
    expect(environment.evaluate(`'1' in parseJson('{"1": 1}')`)).toBe(true);
    expect(environment.evaluate(`parseJson('{"a": 1}').map(k, k)`)).toEqual(["a"]);
    // A JSON object is a RECORD here, so a non-string key cannot name an entry of it at
    // all — which is a fact about the record, not about the numeric types.
    expect(refusal(() => environment.evaluate(`parseJson('{"1": 7}')[1]`)).code).toBe(
      "unsupported_key_type",
    );
  });

  it("compares a map against a record by key identity, across the two representations", () => {
    const environment = base().registerVariable("record", "dyn");
    const record: CelValue = { a: 1n, "1": 2n } as unknown as CelValue;
    // A host's plain object is a map here, and a string key stays a string key in both.
    expect(environment.evaluate("record == {'a': 1, '1': 2}", { record })).toBe(true);
    expect(environment.evaluate("record == {'a': 1, 1: 2}", { record })).toBe(false);
  });
});
