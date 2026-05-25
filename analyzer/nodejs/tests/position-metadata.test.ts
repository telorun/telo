import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import {
  buildDocumentPositions,
  buildLineOffsets,
  buildPositionIndex,
  documentLineOffsets,
} from "../src/position-metadata.js";

function parse(text: string) {
  return parseAllDocuments(text, { customTags: defaultCustomTags() });
}

/** Slice the original source for a recorded range and return the substring,
 *  with any trailing newline trimmed. yaml's `Scalar.range` includes the
 *  newline that terminates a flow scalar, so the raw slice for `name: alice\n`
 *  is `"alice\n"` — the oracle strips the terminator so the assertion reads
 *  as "the range covers exactly this value". */
function sliceByRange(
  text: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
): string {
  const lines = text.split("\n");
  let raw: string;
  if (range.start.line === range.end.line) {
    raw = lines[range.start.line].slice(range.start.character, range.end.character);
  } else {
    const out: string[] = [];
    out.push(lines[range.start.line].slice(range.start.character));
    for (let i = range.start.line + 1; i < range.end.line; i++) out.push(lines[i]);
    out.push(lines[range.end.line].slice(0, range.end.character));
    raw = out.join("\n");
  }
  return raw.replace(/\n$/, "");
}

// ---------------------------------------------------------------------------
// documentLineOffsets
// ---------------------------------------------------------------------------

describe("documentLineOffsets", () => {
  it("returns [0] for a single-document file with no separator", () => {
    expect(documentLineOffsets("kind: Foo\nmetadata:\n  name: a\n")).toEqual([0]);
  });

  it("returns [0] for an empty file", () => {
    expect(documentLineOffsets("")).toEqual([0]);
  });

  it("treats a leading '---' as doc 0's start marker, not a separator", () => {
    // A '---' at line 0 marks the beginning of doc 0; the yaml parser still
    // emits exactly one document. The offsets array must stay [0] so it
    // aligns with parsedDocs.length — otherwise diagnostics for later docs
    // get attributed one entry too early and land inside the previous doc.
    expect(documentLineOffsets("---\nkind: Foo\n")).toEqual([0]);
  });

  it("aligns offsets with parsed docs when a multi-doc file starts with '---'", () => {
    // Two docs, file starts with '---'. The leading '---' is doc 0's start
    // marker; only the inner '---' is a real separator. Offsets stay [0, 3]
    // (one per doc), preventing the off-by-one that previously misattributed
    // doc N's diagnostics to doc N-1's line range.
    const text = ["---", "kind: A", "---", "kind: B", ""].join("\n");
    expect(documentLineOffsets(text)).toEqual([0, 3]);
  });

  it("records each '---' separator as a new doc start (next line)", () => {
    const text = ["kind: A", "---", "kind: B", "---", "kind: C", ""].join("\n");
    expect(documentLineOffsets(text)).toEqual([0, 2, 4]);
  });

  it("treats '--- ' (separator followed by a directive comment) as a doc start", () => {
    // YAML allows trailing content after the separator on the same line; the
    // helper keys only on the line beginning, so this counts as a doc start.
    const text = ["kind: A", "--- # next doc", "kind: B"].join("\n");
    expect(documentLineOffsets(text)).toEqual([0, 2]);
  });

  it("does NOT treat indented '---' as a doc separator", () => {
    // YAML parsers only interpret '---' at column 0 as a directive end. The
    // helper enforces this by trimming only trailing whitespace, so a leading
    // space on '---' keeps it as ordinary string content.
    const text = ["kind: A", "  ---", "  more: stuff"].join("\n");
    expect(documentLineOffsets(text)).toEqual([0]);
  });

  it("handles CRLF line endings (\\r is whitespace, trimmed)", () => {
    // text.split("\n") leaves a trailing \r on each split; trimEnd clears it
    // so the '---' detection still fires. Important for files authored on
    // Windows or pasted from Windows-origin sources.
    const text = "kind: A\r\n---\r\nkind: B\r\n";
    expect(documentLineOffsets(text)).toEqual([0, 2]);
  });
});

// ---------------------------------------------------------------------------
// buildLineOffsets
// ---------------------------------------------------------------------------

describe("buildLineOffsets", () => {
  it("returns [0] for an empty string", () => {
    expect(buildLineOffsets("")).toEqual([0]);
  });

  it("returns [0] for a single line with no newline", () => {
    expect(buildLineOffsets("kind: Foo")).toEqual([0]);
  });

  it("records the byte offset of each line start", () => {
    // "ab\ncd\nef" — line 0 starts at 0, line 1 at 3 (after "ab\n"), line 2
    // at 6 (after "cd\n"). The trailing line has no terminator so no extra
    // entry follows.
    expect(buildLineOffsets("ab\ncd\nef")).toEqual([0, 3, 6]);
  });

  it("appends a final entry when the text ends with a newline", () => {
    // A trailing "\n" creates a (possibly empty) next line; the offset table
    // points one past the end so callers iterating by line don't overshoot.
    expect(buildLineOffsets("ab\ncd\n")).toEqual([0, 3, 6]);
  });

  it("treats CRLF as two characters: \\r stays on the previous line", () => {
    // The offset advances by len("ab\r\n") = 4, so line 1 starts at 4. CRLF
    // semantics for offsetToPosition are correct because the line content
    // includes the trailing \r — character indices still align with the
    // original byte stream.
    expect(buildLineOffsets("ab\r\ncd")).toEqual([0, 4]);
  });
});

// ---------------------------------------------------------------------------
// buildPositionIndex
// ---------------------------------------------------------------------------

describe("buildPositionIndex", () => {
  it("returns an empty index for a document whose root is a bare scalar", () => {
    // A doc whose root contents is a Scalar (not a Map or Seq) has no
    // key-value pairs to record. The walker only descends into Maps and
    // Seqs, so the index stays empty without throwing — important because
    // diagnostic resolution for an in-progress / partially-typed file
    // shouldn't crash.
    const text = "null\n";
    const docs = parse(text);
    const index = buildPositionIndex(docs[0], buildLineOffsets(text));
    expect(index.size).toBe(0);
  });

  it("indexes top-level scalar fields", () => {
    const text = "kind: Foo\nname: bar\n";
    const docs = parse(text);
    const lineOffsets = buildLineOffsets(text);
    const index = buildPositionIndex(docs[0], lineOffsets);

    const kind = index.get("kind");
    expect(kind).toBeDefined();
    expect(sliceByRange(text, kind!)).toBe("Foo");

    const name = index.get("name");
    expect(name).toBeDefined();
    expect(sliceByRange(text, name!)).toBe("bar");
  });

  it("indexes nested map fields with dotted paths", () => {
    const text = "kind: Foo\nmetadata:\n  name: alice\n  module: mymod\n";
    const docs = parse(text);
    const index = buildPositionIndex(docs[0], buildLineOffsets(text));

    const name = index.get("metadata.name");
    expect(name).toBeDefined();
    expect(sliceByRange(text, name!)).toBe("alice");

    const module = index.get("metadata.module");
    expect(module).toBeDefined();
    expect(sliceByRange(text, module!)).toBe("mymod");
  });

  it("indexes sequence items with [N] suffix", () => {
    const text = "targets:\n  - One\n  - Two\n  - Three\n";
    const docs = parse(text);
    const index = buildPositionIndex(docs[0], buildLineOffsets(text));

    expect(sliceByRange(text, index.get("targets[0]")!)).toBe("One");
    expect(sliceByRange(text, index.get("targets[1]")!)).toBe("Two");
    expect(sliceByRange(text, index.get("targets[2]")!)).toBe("Three");
  });

  it("indexes mixed sequence-of-map paths", () => {
    const text = [
      "routes:",
      "  - request:",
      "      path: /hello",
      "    handler:",
      "      kind: JS.Script",
      "",
    ].join("\n");
    const docs = parse(text);
    const index = buildPositionIndex(docs[0], buildLineOffsets(text));

    expect(sliceByRange(text, index.get("routes[0].request.path")!)).toBe("/hello");
    expect(sliceByRange(text, index.get("routes[0].handler.kind")!)).toBe("JS.Script");
  });

  it("spans a multi-line block scalar from start to end", () => {
    const text = ["code: |", "  function main() {", "    return 1;", "  }", ""].join("\n");
    const docs = parse(text);
    const index = buildPositionIndex(docs[0], buildLineOffsets(text));

    const code = index.get("code");
    expect(code).toBeDefined();
    // The recorded range starts at the `|` indicator on the header line and
    // ends after the last content line. What matters for downstream callers
    // (Monaco markers, VS Code Diagnostics) is that the span crosses lines
    // so the squiggle covers the whole block — not the exact start column.
    expect(code!.end.line).toBeGreaterThan(code!.start.line);
  });

  it("uses dotted joining even when keys contain '.', pinning current behaviour", () => {
    // `headers.Content-Type` — the joiner is unconditional `.`, so a key
    // containing a dot or a hyphen produces a path string that's ambiguous
    // with `headers.Content` having a child `Type`. This is current behaviour
    // and matches what the analyzer's diagnostics emit, so resolution still
    // works end-to-end. Any future move to JSON-pointer escaping is an
    // intentional change — this test fails first if someone reworks the
    // joiner without updating the analyzer's diagnostic-path emission.
    const text = "headers:\n  Content-Type: application/json\n";
    const docs = parse(text);
    const index = buildPositionIndex(docs[0], buildLineOffsets(text));

    const ct = index.get("headers.Content-Type");
    expect(ct).toBeDefined();
    expect(sliceByRange(text, ct!)).toBe("application/json");
  });

  it("scopes paths to the document's own root (no leakage from sibling docs)", () => {
    const text = ["kind: A", "name: alice", "---", "kind: B", "name: bob", ""].join("\n");
    const docs = parse(text);
    const lineOffsets = buildLineOffsets(text);

    const idx0 = buildPositionIndex(docs[0], lineOffsets);
    const idx1 = buildPositionIndex(docs[1], lineOffsets);

    // Same key, different ranges — each doc owns its own slice of the file.
    expect(sliceByRange(text, idx0.get("kind")!)).toBe("A");
    expect(sliceByRange(text, idx1.get("kind")!)).toBe("B");
    expect(sliceByRange(text, idx0.get("name")!)).toBe("alice");
    expect(sliceByRange(text, idx1.get("name")!)).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// buildDocumentPositions
// ---------------------------------------------------------------------------

describe("buildDocumentPositions", () => {
  it("returns one entry per parsed document, in order", () => {
    const text = ["kind: A", "---", "kind: B", "---", "kind: C", ""].join("\n");
    const docs = parse(text);
    const positions = buildDocumentPositions(text, docs);

    expect(positions).toHaveLength(3);
    expect(positions[0].sourceLine).toBe(0);
    expect(positions[1].sourceLine).toBe(2);
    expect(positions[2].sourceLine).toBe(4);
  });

  it("aligns positionIndex per doc and matches sliceByRange against original text", () => {
    const text = ["kind: A", "name: first", "---", "kind: B", "name: second", ""].join("\n");
    const docs = parse(text);
    const positions = buildDocumentPositions(text, docs);

    expect(sliceByRange(text, positions[0].positionIndex.get("name")!)).toBe("first");
    expect(sliceByRange(text, positions[1].positionIndex.get("name")!)).toBe("second");
  });

  it("handles a leading '---' directive at line 0", () => {
    const text = ["---", "kind: Foo", ""].join("\n");
    const docs = parse(text);
    const positions = buildDocumentPositions(text, docs);

    // The parser produces a single document and documentLineOffsets reports
    // [0] — the leading '---' is doc 0's start marker, not a separator, so
    // there is no extra offset to drift later docs' sourceLine attribution.
    expect(positions).toHaveLength(1);
    expect(positions[0].sourceLine).toBe(0);
    expect(sliceByRange(text, positions[0].positionIndex.get("kind")!)).toBe("Foo");
  });
});

