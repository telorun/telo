import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Document, parseAllDocuments } from "yaml";
import { parseRefSource } from "../src/engines/ref.js";
import { expansionTagMisuse } from "../src/expansion-tags.js";
import { defaultCustomTags } from "../src/yaml-tags.js";

// The tag vectors (`templating/tag-conformance/`), which the Rust loader runs too.
const vectors = <T>(file: string): T[] =>
  JSON.parse(readFileSync(new URL(`../../tag-conformance/${file}`, import.meta.url), "utf8")) as T[];

interface RefRow {
  name: string;
  source: string;
  parsed?: unknown;
  refusal?: unknown;
}

interface SentinelRow {
  name: string;
  yaml: string;
  json?: unknown;
  refusal?: { code: string };
}

describe("ref.json", () => {
  for (const row of vectors<RefRow>("ref.json")) {
    it(row.name, () => {
      const expected = row.refusal ? { refusal: row.refusal } : { parsed: row.parsed };
      expect(JSON.stringify(parseRefSource(row.source))).toBe(JSON.stringify(expected));
    });
  }
});

describe("sentinels.json", () => {
  for (const row of vectors<SentinelRow>("sentinels.json")) {
    it(row.name, () => {
      const [document] = parseAllDocuments(row.yaml, { customTags: defaultCustomTags() });
      const misuse = expansionTagMisuse(document as Document);
      if (row.refusal) {
        expect(misuse.map((m) => m.code)).toEqual([row.refusal.code]);
        return;
      }
      expect(misuse).toEqual([]);
      // Compared as text, so key order is part of the answer.
      expect(JSON.stringify((document as Document).toJSON())).toBe(JSON.stringify(row.json));
    });
  }
});

describe("round-trip.json", () => {
  for (const row of vectors<{ name: string; yaml: string; written?: string }>("round-trip.json")) {
    it(row.name, () => {
      const documents = parseAllDocuments(row.yaml, { customTags: defaultCustomTags() });
      expect(documents.flatMap((d) => (d as Document).errors)).toEqual([]);
      expect(documents.map((d) => String(d)).join("")).toBe(row.written ?? row.yaml);
    });
  }
});

describe("a node built from a loaded expansion mapping", () => {
  it("is written behind its tag, metadata first, without the marker", () => {
    const document = new Document(
      { db: { __expand: "if", if: true, then: { kind: "A" }, metadata: { name: "db" } } },
      { customTags: defaultCustomTags() },
    );
    expect(String(document)).toBe(
      "db: !if\n  metadata:\n    name: db\n  if: true\n  then:\n    kind: A\n",
    );
  });
});
