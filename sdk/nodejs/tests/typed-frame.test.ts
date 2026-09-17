/**
 * The typed frame — `kernel/specs/durable-execution.md` §6. The conformance
 * vectors are read from the JSON beside the spec, which the Rust SDK reads too,
 * and the spec's own tables are checked against that JSON so neither drifts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Duration, UnsignedInt } from "../src/cel-value-identity.js";
import { isInvokeError } from "../src/invoke-error.js";
import { decodeTypedFrame, encodeTypedFrame } from "../src/typed-frame.js";

const SPECS = new URL("../../../kernel/specs/", import.meta.url);

type Notation = Record<string, any>;
interface EncodableVector {
  name: string;
  value: Notation;
  frame: string;
}
interface UndecodableVector {
  name: string;
  frame: string;
  path: string;
}
interface ReadableVector {
  name: string;
  frame: string;
  value: Notation;
  canonical: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("durable-execution-typed-frame-vectors.json", SPECS), "utf8"),
) as {
  encodable: EncodableVector[];
  undecodable: UndecodableVector[];
  readable: ReadableVector[];
  doubles: [bits: string, text: string][];
};

const TAGGED_DOUBLES: Record<string, number> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
  "-0": -0,
};

/** The value a vector's notation (§6.6) describes, built from the host's own
 *  constructors rather than from any frame form. */
function build(notation: Notation): unknown {
  const [type] = Object.keys(notation);
  const body = notation[type!];
  switch (type) {
    case "null":
      return null;
    case "bool":
    case "string":
      return body;
    case "double":
      return typeof body === "number" ? body : TAGGED_DOUBLES[body];
    case "int":
      return BigInt(body);
    case "uint":
      return new UnsignedInt(BigInt(body));
    case "bytes":
      return new Uint8Array(body);
    case "timestamp":
      return new Date(Number(BigInt(body.seconds) * 1000n) + body.nanos / 1_000_000);
    case "duration":
      return new Duration(BigInt(body.seconds), body.nanos);
    case "list":
      return body.map(build);
    case "map": {
      const entries = (body as [Notation, Notation][]).map(
        ([key, value]): [unknown, unknown] => [build(key), build(value)],
      );
      return entries.every(([key]) => typeof key === "string")
        ? Object.fromEntries(entries)
        : new Map(entries);
    }
  }
  throw new Error(`Unknown value notation '${type}'`);
}

function totalNanos(value: Duration): bigint {
  return value.seconds * 1_000_000_000n + BigInt(value.nanos);
}

function entriesOf(value: object): [unknown, unknown][] {
  return value instanceof Map ? [...value] : Object.entries(value);
}

/** CEL value equality with the CEL type included, written without the codec:
 *  a string-keyed `Map` and a plain object are one map, an int and a double are
 *  not one number, and NaN and negative zero are compared by identity. */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Object.is(a, b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  const both = <T>(type: abstract new (...args: any[]) => T): [T, T] | undefined =>
    a instanceof type && b instanceof type ? [a as T, b as T] : undefined;
  const isOne = (type: abstract new (...args: any[]) => unknown) => a instanceof type || b instanceof type;

  if (isOne(UnsignedInt)) {
    const pair = both(UnsignedInt);
    return !!pair && pair[0].valueOf() === pair[1].valueOf();
  }
  if (isOne(Uint8Array)) {
    const pair = both(Uint8Array);
    return !!pair && pair[0].length === pair[1].length && pair[0].every((byte, i) => byte === pair[1][i]);
  }
  if (isOne(Date)) {
    const pair = both(Date);
    return !!pair && pair[0].getTime() === pair[1].getTime();
  }
  if (isOne(Duration)) {
    const pair = both(Duration);
    return !!pair && totalNanos(pair[0]) === totalNanos(pair[1]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]))
    );
  }
  const left = entriesOf(a);
  const right = entriesOf(b);
  return (
    left.length === right.length &&
    left.every(([key, value]) => {
      const match = right.find(([other]) => sameValue(key, other));
      return match !== undefined && sameValue(value, match[1]);
    })
  );
}

function thrown(run: () => unknown): { code: unknown; path: unknown } {
  try {
    run();
  } catch (err) {
    if (!isInvokeError(err)) throw err;
    return { code: err.code, path: (err.data as { path?: unknown } | undefined)?.path };
  }
  throw new Error("expected a refusal, and nothing was thrown");
}

describe("typed frame conformance vectors", () => {
  it.each(vectors.encodable)("writes and reads $name", ({ value, frame }) => {
    const built = build(value);
    expect(encodeTypedFrame(built)).toBe(frame);
    expect(sameValue(decodeTypedFrame(frame), built)).toBe(true);
  });

  it.each(vectors.undecodable)("refuses to read $name", ({ frame, path }) => {
    expect(thrown(() => decodeTypedFrame(frame))).toEqual({ code: "ERR_TYPED_FRAME_UNDECODABLE", path });
  });

  it.each(vectors.readable)("reads $name and writes it canonically", ({ frame, value, canonical }) => {
    const read = decodeTypedFrame(frame);
    expect(sameValue(read, build(value))).toBe(true);
    expect(encodeTypedFrame(read)).toBe(canonical);
  });

  it("writes every double of the shared corpus", () => {
    const view = new DataView(new ArrayBuffer(8));
    const mismatches = vectors.doubles.filter(([bits, text]) => {
      view.setBigUint64(0, BigInt(`0x${bits}`));
      return encodeTypedFrame(view.getFloat64(0)) !== text;
    });
    expect(mismatches).toEqual([]);
  });

  it("are the rows of the spec's tables", () => {
    const spec = readFileSync(new URL("durable-execution.md", SPECS), "utf8");
    const start = spec.indexOf("### 6.6");
    const section = spec.slice(start, spec.indexOf("\n## ", start));
    const rows = section.split("\n").filter((line) => /^\| [^|]+ \| `/.test(line));
    expect(rows).toEqual([
      ...vectors.encodable.map((v) => `| ${v.name} | \`${JSON.stringify(v.value)}\` | \`${v.frame}\` |`),
      ...vectors.undecodable.map((v) => `| ${v.name} | \`${v.frame}\` | \`${JSON.stringify(v.path)}\` |`),
      ...vectors.readable.map(
        (v) => `| ${v.name} | \`${v.frame}\` | \`${JSON.stringify(v.value)}\` | \`${v.canonical}\` |`,
      ),
    ]);
  });
});

describe("typed frame over generated values", () => {
  let seed = 0x7e10;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const below = (n: number) => Math.floor(random() * n);
  const pick = <T>(items: readonly T[]): T => items[below(items.length)]!;
  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = below(i + 1);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  };

  const DOUBLES = [0, -0, 1, 1.5, -2.25, 0.1, 1e21, 1e-7, 5e-324, Number.MAX_VALUE, NaN, Infinity, -Infinity];
  const INTS = [0n, 1n, -1n, 9007199254740993n, 2n ** 63n - 1n, -(2n ** 63n)];
  const UINTS = [0n, 1n, 2n ** 64n - 1n];
  const STRINGS = [
    ...["", "a", "1", "true", "$telo", "value", "__proto__", 'q"\\'],
    String.fromCharCode(0x0a, 0x09, 0x00, 0x1f),
    String.fromCharCode(0x7f, 0x2028),
    String.fromCharCode(0xe9),
    String.fromCodePoint(0x1f600),
    String.fromCharCode(0xff5a),
  ];
  const MIN_INSTANT = -62135596800000;
  const MAX_INSTANT = 253402300799999;
  const MAX_SECONDS = 315576000000;

  /** A value and a second host representation of the same value, built with a
   *  different insertion order, container class or Duration normalization. */
  function generate(depth: number): [unknown, unknown] {
    switch (below(depth > 0 ? 12 : 9)) {
      case 0: {
        const value = pick([null, true, false]);
        return [value, value];
      }
      case 1: {
        const value = random() < 0.7 ? pick(DOUBLES) : (random() - 0.5) * 1e6;
        return [value, value];
      }
      case 2: {
        const value = random() < 0.7 ? pick(INTS) : BigInt(Math.floor((random() - 0.5) * 1e12));
        return [value, value];
      }
      case 3: {
        const value = pick(UINTS);
        return [new UnsignedInt(value), new UnsignedInt(value)];
      }
      case 4: {
        const value = pick(STRINGS);
        return [value, value];
      }
      case 5: {
        const bytes = Array.from({ length: below(6) }, () => below(256));
        return [new Uint8Array(bytes), Buffer.from(bytes)];
      }
      case 6: {
        const instant = random() < 0.3 ? pick([MIN_INSTANT, MAX_INSTANT, 0, -1]) : MIN_INSTANT + Math.floor(random() * (MAX_INSTANT - MIN_INSTANT));
        return [new Date(instant), new Date(instant)];
      }
      case 7: {
        const sign = random() < 0.5 ? -1 : 1;
        const seconds = BigInt(sign * below(random() < 0.2 ? MAX_SECONDS + 1 : 100_000));
        const nanos = sign * pick([0, 1, 500_000_000, 999_999_999, below(1_000_000_000)]);
        const reshaped = nanos < 0 ? new Duration(seconds - 1n, nanos + 1_000_000_000) : new Duration(seconds, nanos);
        return [new Duration(seconds, nanos), reshaped];
      }
      case 8:
      case 9: {
        const pairs = Array.from({ length: below(4) }, () => generate(depth - 1));
        return [pairs.map(([value]) => value), pairs.map(([, reshaped]) => reshaped)];
      }
      case 10: {
        const keys = [...new Set(Array.from({ length: below(4) }, () => pick(STRINGS)))];
        const pairs = keys.map((key) => [key, generate(depth - 1)] as const);
        const value = Object.fromEntries(pairs.map(([key, [v]]) => [key, v]));
        const reshapedEntries = shuffle(pairs.map(([key, [, r]]) => [key, r] as [string, unknown]));
        return [value, random() < 0.5 ? new Map(reshapedEntries) : Object.fromEntries(reshapedEntries)];
      }
      default: {
        const candidates: unknown[] = [...STRINGS, true, false, 0n, 1n, -1n, 2n, 10n];
        const byIdentity = new Map<string, () => unknown>();
        for (let i = below(4); i >= 0; i--) {
          const choice = below(candidates.length + 3);
          if (choice < candidates.length) {
            const key = candidates[choice];
            // An int and a uint of one number are ONE key in CEL, so a generated
            // map must not hold both.
            const identity = typeof key === "bigint" ? `number:${key}` : `${typeof key}:${String(key)}`;
            byIdentity.set(identity, () => key);
          } else {
            const n = BigInt(choice - candidates.length);
            byIdentity.set(`number:${n}`, () => new UnsignedInt(n));
          }
        }
        const pairs = [...byIdentity.values()].map((key) => [key, generate(depth - 1)] as const);
        const value = new Map(pairs.map(([key, [v]]) => [key(), v]));
        const reshaped = new Map(shuffle(pairs.map(([key, [, r]]) => [key(), r] as [unknown, unknown])));
        return [value, reshaped];
      }
    }
  }

  it("decode inverts encode, distinct values never share a frame, and one value has one text", () => {
    const byFrame = new Map<string, unknown>();
    for (let sample = 0; sample < 4000; sample++) {
      const [value, reshaped] = generate(3);
      const frame = encodeTypedFrame(value);
      expect(encodeTypedFrame(reshaped), frame).toBe(frame);
      const decoded = decodeTypedFrame(frame);
      expect(sameValue(decoded, value), frame).toBe(true);
      expect(encodeTypedFrame(decoded), frame).toBe(frame);
      if (byFrame.has(frame)) expect(sameValue(byFrame.get(frame), value), frame).toBe(true);
      else byFrame.set(frame, value);
    }
  });
});

describe("typed frame refusals", () => {
  class Money {
    constructor(readonly amount: number) {}
    toJSON() {
      return { amount: this.amount };
    }
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = [1, , 2];

  it.each([
    ["a class instance relying on toJSON", { price: new Money(5) }, "/price"],
    ["a function", [1, () => 1], "/1"],
    ["a symbol", { s: Symbol("s") }, "/s"],
    ["undefined inside a map", { a: { b: undefined } }, "/a/b"],
    ["undefined inside a list", [undefined], "/0"],
    ["undefined itself", undefined, ""],
    ["a hole in a sparse list", sparse, "/1"],
    ["a Map with a double key", { m: new Map([[1.5, "x"]]) }, "/m"],
    ["a Map with an object key", new Map([[{}, "x"]]), ""],
    ["a Map with two equal uint keys", new Map([[new UnsignedInt(1n), "a"], [new UnsignedInt(1n), "b"]]), ""],
    ["a Map with an int and a uint key of one number", new Map<unknown, string>([[2n, "a"], [new UnsignedInt(2n), "b"]]), ""],
    ["a symbol-keyed property", { [Symbol("k")]: 1 }, ""],
    ["a property beside a list's items", { items: Object.assign([1n], { tag: "x" }) }, "/items/tag"],
    ["an int beyond int64", { n: 2n ** 63n }, "/n"],
    ["an instant beyond year 9999", [new Date(253402300800000)], "/0"],
    ["an invalid Date", new Date(Number.NaN), ""],
    ["a duration beyond CEL's range", { d: new Duration(315576000001n) }, "/d"],
    ["an unpaired surrogate", { "a/b~c": "\uD800" }, "/a~1b~0c"],
    ["a cycle", cyclic, "/self"],
    ["a typed array other than bytes", new Int8Array(1), ""],
    ["a Set", new Set([1]), ""],
  ])("refuses %s at its path", (label, value, path) => {
    expect(thrown(() => encodeTypedFrame(value)), label).toEqual({ code: "ERR_TYPED_FRAME_UNENCODABLE", path });
  });
});
