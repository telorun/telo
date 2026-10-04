/**
 * The typed frame and the CEL engine answer "are these two keys ONE key" the same way.
 *
 * Both have to answer it. The engine keys a `CelMap`'s entries so that `1` and `1u` are one
 * key, as CEL equality requires; the frame refuses a PAYLOAD carrying two such keys rather
 * than reading two entries a consumer would have to reconcile. The engine does not export
 * its rule — what identifies an entry is its entries map's own business — and the frame's
 * refusals name the path they were found at and the key that repeats, which are the FRAME's
 * wire contract and not the engine's wording. So the rule is stated twice on purpose.
 *
 * **The READ path is where the frame still owns it**, which is why that is the side compared
 * here. A map the frame WRITES is a `CelMap`, and the engine's builder has already refused a
 * duplicate before the writer sees one — so the writer's own dedup is an invariant it can no
 * longer be handed a violation of, while a payload from another writer can carry anything.
 *
 * This is what keeps the two from drifting, and it compares them by **behaviour** rather
 * than by reading two private functions: a pair is one key iff the engine refuses the map
 * literal as a duplicate, and iff the frame refuses to read the payload. Either side moving
 * alone fails here.
 *
 * **Its filter, and what it cannot reach.** The pairs are enumerated from a key set, so a
 * key TYPE neither side admits is covered only where the set names one; a type added to
 * CEL's four key types would need a row here. What the set is built to attack is exactly the
 * namespace the engine's old prefixed text existed to separate — `"1"` against `1`, `"true"`
 * against `true`, a uint against an int of the same number, and a double that is whole
 * against one that is not.
 */
import { describe, expect, it } from "vitest";
import { celMapFromEntries, isCelError } from "@telorun/cel";
import { celUint, type CelValue } from "../src/cel-value-identity.js";
import { decodeTypedFrame, encodeTypedFrame } from "../src/typed-frame.js";

const KEYS: readonly { readonly what: string; readonly key: unknown }[] = [
  { what: '"1"', key: "1" },
  { what: '"2"', key: "2" },
  { what: '"true"', key: "true" },
  { what: '"n1"', key: "n1" },
  { what: '"s1"', key: "s1" },
  { what: '"b1"', key: "b1" },
  { what: '"__proto__"', key: "__proto__" },
  { what: '""', key: "" },
  { what: "1 (int)", key: 1n },
  { what: "2 (int)", key: 2n },
  { what: "0 (int)", key: 0n },
  { what: "1u (uint)", key: celUint(1n) },
  { what: "2u (uint)", key: celUint(2n) },
  { what: "true", key: true },
  { what: "false", key: false },
];

/** Whether the ENGINE makes the two one key: it refuses a map that carries both. */
function engineMakesOneKey(left: unknown, right: unknown): boolean {
  const held = celMapFromEntries([left as CelValue, "a", right as CelValue, "b"]);
  return isCelError(held) && held.code === "duplicate_map_key";
}

/**
 * Whether the FRAME makes the two one key: it refuses to READ a payload carrying both.
 *
 * Two refusals are recognised, each with its own meaning. *Repeats a key* is the rule
 * answering yes. *Written untagged* is the reader refusing the SHAPE before it compares
 * anything — which only happens when both keys are strings, and two distinct strings are
 * never one key, so it answers no. Anything else is a defect and propagates.
 */
function frameMakesOneKey(left: unknown, right: unknown): boolean {
  const pairs = `[[${encodeTypedFrame(left)},"a"],[${encodeTypedFrame(right)},"b"]]`;
  try {
    decodeTypedFrame(`{"$telo":"map","value":${pairs}}`);
    return false;
  } catch (cause) {
    const message = (cause as Error).message;
    if (message.includes("repeats a key already in the map")) return true;
    if (message.includes("which is written untagged")) return false;
    throw cause;
  }
}

describe("what makes two map keys one key", () => {
  it("is the same answer in the typed frame and in the engine, for every pair", () => {
    const differences: string[] = [];
    let pairs = 0;
    let merged = 0;
    for (let i = 0; i < KEYS.length; i += 1) {
      for (let j = i + 1; j < KEYS.length; j += 1) {
        const left = KEYS[i]!;
        const right = KEYS[j]!;
        const engine = engineMakesOneKey(left.key, right.key);
        const frame = frameMakesOneKey(left.key, right.key);
        pairs += 1;
        if (engine) merged += 1;
        if (engine !== frame) {
          differences.push(`${left.what} vs ${right.what}: engine ${engine}, frame ${frame}`);
        }
      }
    }
    expect(differences).toEqual([]);
    // The set must actually MERGE something, or the comparison is "both said no" throughout
    // and would pass with either rule replaced by a constant.
    expect(merged, "the key set must contain pairs the two rules merge").toBeGreaterThan(0);
    expect(pairs).toBe((KEYS.length * (KEYS.length - 1)) / 2);
  });

  it("merges an int with a uint of the same number, and nothing across the other types", () => {
    expect(engineMakesOneKey(1n, celUint(1n))).toBe(true);
    expect(frameMakesOneKey(1n, celUint(1n))).toBe(true);
    for (const [left, right] of [
      ["1", 1n],
      ["1", celUint(1n)],
      ["true", true],
      ["n1", 1n],
      [1n, 2n],
      [true, false],
      [true, 1n],
    ] as const) {
      expect(engineMakesOneKey(left, right), `${String(left)} vs ${String(right)}`).toBe(false);
      expect(frameMakesOneKey(left, right), `${String(left)} vs ${String(right)}`).toBe(false);
    }
  });
});
