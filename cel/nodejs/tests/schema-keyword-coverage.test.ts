import { describe, expect, it } from "vitest";
import { formatType } from "../src/cel-type.js";
import type { JsonSchemaDocument } from "../src/json-schema-type.js";
import {
  schemaType,
  TYPE_CONSTRAINING_KEYWORDS,
  TYPE_KEYWORDS_READ,
} from "../src/json-schema-type.js";

/**
 * The gate over the closed keyword list: **every keyword that can move a type is either
 * read or reported**, held in both directions.
 *
 * - A keyword on `TYPE_KEYWORDS_READ` must actually decide the type: the probe carrying it
 *   must type differently from the same node without it, and must never be reported. So
 *   adding a keyword to that list without implementing it fails here rather than passing
 *   as a claim nothing checks.
 * - A keyword on the closed list that is **not** on `TYPE_KEYWORDS_READ` must appear in the
 *   report, with `keyword-not-read`. So adding a keyword the reader does not implement is
 *   a one-line change that is complete the moment it is made.
 * - Every keyword on the closed list must have a probe here, so a list entry cannot be
 *   added without being exercised.
 *
 * **The filter this applies, and the class it cannot reach.** The filter is "a keyword on
 * the engine's own closed list". A keyword that constrains a value's type and is on **no**
 * list at all passes straight through it: the reader sees a node carrying nothing it knows,
 * types it `dyn`, and reports nothing — exactly the silence this whole mechanism exists to
 * end. Nothing under this package can close that class, because nothing here knows JSON
 * Schema's vocabulary and inventing a second list of it would be the same list twice. What
 * covers it instead is that the behaviour is pinned explicitly below rather than left
 * implied ("a keyword on no list"), so the cost of a missing entry is a stated fact, and
 * that the list and the reader are held to each other here in both directions, so adding
 * the entry is one line that cannot be half done.
 */

/** A node carrying exactly one of the keywords, and the document it is read in. */
const PROBES: Readonly<Record<string, JsonSchemaDocument>> = {
  $dynamicRef: { node: { $dynamicRef: "#shape" } },
  $recursiveRef: { node: { $recursiveRef: "#" } },
  $ref: {
    node: { $ref: "#/$defs/Shape" },
    root: { $ref: "#/$defs/Shape", $defs: { Shape: { type: "string" } } },
  },
  additionalItems: { node: { additionalItems: { type: "string" } } },
  additionalProperties: { node: { additionalProperties: { type: "string" } } },
  allOf: { node: { allOf: [{ type: "string" }] } },
  anyOf: { node: { anyOf: [{ type: "string" }] } },
  const: { node: { const: "fixed" } },
  dependentSchemas: { node: { dependentSchemas: { a: { type: "string" } } } },
  else: { node: { else: { type: "string" } } },
  enum: { node: { enum: ["fixed"] } },
  if: { node: { if: { type: "string" } } },
  items: { node: { items: { type: "string" } } },
  not: { node: { not: { const: "fixed" } } },
  oneOf: { node: { oneOf: [{ type: "string" }] } },
  patternProperties: { node: { patternProperties: { "^a": { type: "string" } } } },
  prefixItems: { node: { prefixItems: [{ type: "string" }] } },
  properties: { node: { properties: { a: { type: "string" } } } },
  then: { node: { then: { type: "string" } } },
  type: { node: { type: "string" } },
  unevaluatedItems: { node: { unevaluatedItems: { type: "string" } } },
  unevaluatedProperties: { node: { unevaluatedProperties: { type: "string" } } },
};

describe("the closed list of type-constraining keywords", () => {
  it("is sorted, holds no duplicate, and has the read ones among it", () => {
    expect(TYPE_CONSTRAINING_KEYWORDS).toEqual([...new Set(TYPE_CONSTRAINING_KEYWORDS)].sort());
    expect(TYPE_KEYWORDS_READ).toEqual([...new Set(TYPE_KEYWORDS_READ)].sort());
    for (const keyword of TYPE_KEYWORDS_READ) expect(TYPE_CONSTRAINING_KEYWORDS).toContain(keyword);
  });

  it("has a probe for every keyword on it, and probes nothing that is not", () => {
    expect(Object.keys(PROBES).sort()).toEqual([...TYPE_CONSTRAINING_KEYWORDS].sort());
  });

  it("reads every keyword it claims to read, and that keyword decides the type", () => {
    for (const keyword of TYPE_KEYWORDS_READ) {
      const probe = PROBES[keyword]!;
      const read = schemaType(probe);
      const without = schemaType({ node: strip(probe.node, keyword), ...(probe.root ? { root: probe.root } : {}) });
      expect(formatType(read.type, true), keyword).not.toBe(formatType(without.type, true));
      expect(
        read.unjudged.filter((entry) => entry.keywords.includes(keyword)),
        keyword,
      ).toEqual([]);
    }
  });

  it("reports every keyword it does not read, with the node that carries it", () => {
    const unread = TYPE_CONSTRAINING_KEYWORDS.filter((keyword) => !TYPE_KEYWORDS_READ.includes(keyword));
    expect(unread.length).toBeGreaterThan(0);
    for (const keyword of unread) {
      const read = schemaType(PROBES[keyword]!);
      expect(read.unjudged, keyword).toEqual([
        { pointer: "", keywords: [keyword], reason: "keyword-not-read" },
      ]);
    }
  });

  it("is silent about a keyword on no list — the stated cost of an entry nobody added", () => {
    const read = schemaType({ node: { someKeywordNobodyListed: { type: "string" } } });
    expect(formatType(read.type, true)).toBe("dyn");
    expect(read.unjudged).toEqual([]);
    expect(read.recursive).toEqual([]);
  });
});

/** The same node without one keyword, so what that keyword decided is measurable. */
function strip(node: Record<string, unknown>, keyword: string): Record<string, unknown> {
  const rest = { ...node };
  delete rest[keyword];
  return rest;
}
