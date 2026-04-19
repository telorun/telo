import { Document, isScalar, parseAllDocuments } from "yaml";
import type { ModuleDocument } from "./model";

/** Parses file text into a ModuleDocument. Captures `loadedJson` — the
 *  semantic snapshot of each doc's `.toJSON()` output at parse time — used
 *  later as the oracle for no-op save detection. If any document has errors,
 *  `parseError` is populated with their joined messages; `docs` is still
 *  returned so downstream code can show the last-good state in the source
 *  view while the user fixes the issue. */
export function parseModuleDocument(filePath: string, text: string): ModuleDocument {
  const docs = parseAllDocuments(text) as Document[];
  const errors: string[] = [];
  for (const d of docs) {
    for (const e of d.errors) errors.push(e.message);
  }
  const loadedJson = docs.map((d) => d.toJSON());
  const base: ModuleDocument = { filePath, text, docs, loadedJson };
  return errors.length ? { ...base, parseError: errors.join("; ") } : base;
}

/** Serializes a multi-document AST back to YAML text. Every document is
 *  preceded by `---` in the output — deterministic regardless of each
 *  document's internal `directives.docStart` state, and regardless of
 *  `yaml` library version changes to the "when to emit `---`" heuristic.
 *  The cost — a leading `---` on the first document — is a one-time
 *  cosmetic shift that tracks the standard multi-document YAML convention.
 *
 *  Non-mutating: `directives.docStart` is snapshotted and restored around
 *  the stringify so external observers of each Document never see the
 *  transient forced-true state. */
export function serializeModuleDocument(docs: Document[]): string {
  type DocStart = NonNullable<Document["directives"]>["docStart"];
  const snapshots: DocStart[] = docs.map((d) =>
    (d.directives ? d.directives.docStart : null) as DocStart,
  );
  try {
    for (const d of docs) {
      if (d.directives) d.directives.docStart = true;
    }
    return docs.map(String).join("\n");
  } finally {
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      if (d.directives) d.directives.docStart = snapshots[i];
    }
  }
}

/** Finds the index of the document in `docs` whose top-level `kind` and
 *  `metadata.name` match. Returns undefined if no match (e.g. the resource
 *  has been renamed in memory but not yet persisted, or the doc is a
 *  kind-less partial). O(n) — callers with O(1) requirements should use
 *  `workspace.resourceDocIndex` instead. */
export function findDocForResource(
  docs: Document[],
  kind: string,
  name: string,
): number | undefined {
  for (let i = 0; i < docs.length; i++) {
    const json = docs[i].toJSON() as { kind?: unknown; metadata?: { name?: unknown } } | null;
    if (!json) continue;
    if (json.kind === kind && json.metadata?.name === name) return i;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON Pointer → path array
// ---------------------------------------------------------------------------

/** Converts an RFC 6901 JSON Pointer to an array path suitable for the `yaml`
 *  library's `setIn` / `getIn` / `deleteIn` APIs. Unescapes `~1` → `/` and
 *  `~0` → `~`; segments that are decimal integers become numbers so the
 *  library treats them as array indices. An empty string pointer targets
 *  the document root (empty path). */
function jsonPointerToPath(pointer: string): (string | number)[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer: ${JSON.stringify(pointer)}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((seg) => {
      const unescaped = seg.replace(/~1/g, "/").replace(/~0/g, "~");
      return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
    });
}

/** Escapes a string for use as a JSON Pointer segment. */
function escapePointerSegment(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}

// ---------------------------------------------------------------------------
// EditOp / applyEdit — the single mutation entry point
// ---------------------------------------------------------------------------

/** One AST-level edit rooted at a JSON Pointer inside a specific document.
 *  Callers batch these (via `diffFields` or hand-rolled) and apply them in
 *  order via repeated `applyEdit` calls. */
export type EditOp =
  | { op: "set"; pointer: string; value: unknown }
  | { op: "delete"; pointer: string }
  | { op: "insert"; pointer: string; value: unknown }
  | { op: "rename"; pointer: string; newKey: string };

/** Applies a single EditOp to `docs[docIndex]` in place, then returns a
 *  spread copy of `docs` so React consumers see a new outer reference.
 *
 *  For `set` ops targeting an existing leaf Scalar where the JS type matches
 *  (both string / number / boolean / null), the Scalar's `.value` is mutated
 *  directly — preserving the node's `.comment` / `.commentBefore` metadata.
 *  Any other `set` (structural replace, missing target, or type change)
 *  falls through to `doc.setIn`, which creates a fresh Scalar and loses the
 *  original node's comment on that specific leaf. Scalar type-change in
 *  place is avoided because the node's resolved YAML tag would go stale and
 *  future serialization could round-trip incorrectly.
 *
 *  `rename` is modeled as read-value + delete-old-key + setIn-new-key, which
 *  loses the comment on the renamed key — acceptable per the plan because
 *  a rename is an intentional structural change. */
export function applyEdit(docs: Document[], docIndex: number, op: EditOp): Document[] {
  const doc = docs[docIndex];
  if (!doc) throw new Error(`applyEdit: no document at index ${docIndex}`);
  const path = jsonPointerToPath(op.pointer);

  switch (op.op) {
    case "set": {
      const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
      if (node && isScalar(node) && sameLeafJsType(node.value, op.value)) {
        node.value = op.value as never;
      } else {
        doc.setIn(path, op.value);
      }
      break;
    }
    case "delete": {
      doc.deleteIn(path);
      break;
    }
    case "insert": {
      // Array append: trailing "-" per JSON Patch convention. Otherwise a
      // map-add that setIn covers naturally (creating missing parent nodes).
      const last = path[path.length - 1];
      if (last === "-") {
        doc.addIn(path.slice(0, -1), op.value);
      } else {
        doc.setIn(path, op.value);
      }
      break;
    }
    case "rename": {
      if (path.length === 0) {
        throw new Error(`applyEdit rename: pointer must target a key (got root)`);
      }
      const parentPath = path.slice(0, -1);
      const value = doc.getIn(path);
      doc.deleteIn(path);
      doc.setIn([...parentPath, op.newKey], value);
      break;
    }
  }

  return [...docs];
}

/** True when two JS leaf values have the same primitive type class. Used by
 *  applyEdit to decide between in-place Scalar mutation (preserves comments)
 *  and a full setIn replace (drops the leaf's comment metadata). */
function sameLeafJsType(a: unknown, b: unknown): boolean {
  if (a === null) return b === null;
  if (b === null) return false;
  if (a === undefined || b === undefined) return false;
  return typeof a === typeof b;
}

// ---------------------------------------------------------------------------
// diffFields — field-object → EditOp[]
// ---------------------------------------------------------------------------

/** Diffs an old form-fields object against a new one and emits EditOps.
 *  Pointers are rooted at `basePointer` (the JSON Pointer into the
 *  containing document — usually `""` for a resource whose whole body is
 *  the fields object, minus `kind` / `metadata`).
 *
 *  Convention (per plan §null-vs-missing-key-vs-empty-string):
 *   - `undefined` in new  → `delete` op
 *   - `null` in new       → `set` op with value `null`
 *   - `""` in new         → `set` op with value `""`
 *   - any other value     → `set` op with that value
 *
 *  Arrays are compared positionally. v1 limitation: reordering
 *  identity-bearing items (e.g. `Run.Sequence.steps` by `name`) produces
 *  set-at-index ops that misattribute comments attached to step-level
 *  nodes. In-place edits to a step behave correctly. Future work can
 *  introduce an `x-telo-*` discriminator annotation to enable identity-
 *  aware array diffing.
 *
 *  Ordering invariant enforced within each array diff: `set` ops emitted
 *  before `delete` ops, with `delete` ops in descending index order. This
 *  matters because array indices shift on delete, and applying set-then-
 *  delete keeps earlier-index ops valid while the trailing deletes trim
 *  the array down to its new length. Callers apply the ops sequentially
 *  in the returned order. */
export function diffFields(
  oldVal: unknown,
  newVal: unknown,
  basePointer: string,
): EditOp[] {
  const ops: EditOp[] = [];
  diffInto(oldVal, newVal, basePointer, ops);
  return ops;
}

function diffInto(
  oldVal: unknown,
  newVal: unknown,
  pointer: string,
  ops: EditOp[],
): void {
  if (newVal === undefined) {
    if (oldVal !== undefined) ops.push({ op: "delete", pointer });
    return;
  }
  // Primitive or shape-mismatched → replace wholesale when values differ.
  if (
    newVal === null ||
    typeof newVal !== "object" ||
    typeof oldVal !== "object" ||
    oldVal === null ||
    Array.isArray(newVal) !== Array.isArray(oldVal)
  ) {
    if (oldVal !== newVal) ops.push({ op: "set", pointer, value: newVal });
    return;
  }
  if (Array.isArray(newVal)) {
    diffArray(oldVal as unknown[], newVal, pointer, ops);
    return;
  }
  diffObject(
    oldVal as Record<string, unknown>,
    newVal as Record<string, unknown>,
    pointer,
    ops,
  );
}

function diffArray(
  oldArr: unknown[],
  newArr: unknown[],
  basePointer: string,
  ops: EditOp[],
): void {
  const trailingDeletes: EditOp[] = [];
  const maxLen = Math.max(oldArr.length, newArr.length);
  for (let i = 0; i < maxLen; i++) {
    const childPointer = `${basePointer}/${i}`;
    if (i >= newArr.length) {
      trailingDeletes.push({ op: "delete", pointer: childPointer });
    } else if (i >= oldArr.length) {
      ops.push({ op: "set", pointer: childPointer, value: newArr[i] });
    } else {
      diffInto(oldArr[i], newArr[i], childPointer, ops);
    }
  }
  // Descending order so earlier indices stay valid as we delete from the tail.
  for (let i = trailingDeletes.length - 1; i >= 0; i--) {
    ops.push(trailingDeletes[i]);
  }
}

function diffObject(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  basePointer: string,
  ops: EditOp[],
): void {
  const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const key of keys) {
    const childPointer = `${basePointer}/${escapePointerSegment(key)}`;
    diffInto(oldObj[key], newObj[key], childPointer, ops);
  }
}

// ---------------------------------------------------------------------------
// Document-level helpers — add / remove whole docs in the docs array
// ---------------------------------------------------------------------------

/** Appends a new resource document (kind / metadata.name / fields) to the
 *  end of the docs array. Non-destructive placement; matches what a user
 *  expects when creating something new. Returns a fresh docs array for React
 *  referential equality. */
export function addResourceDocument(
  docs: Document[],
  kind: string,
  name: string,
  fields: Record<string, unknown>,
): Document[] {
  const content: Record<string, unknown> = { kind, metadata: { name }, ...fields };
  return [...docs, new Document(content)];
}

/** Removes the first document whose top-level `kind` + `metadata.name`
 *  match. Returns the original array when no match is found. */
export function removeResourceDocument(
  docs: Document[],
  kind: string,
  name: string,
): Document[] {
  const idx = findDocForResource(docs, kind, name);
  if (idx === undefined) return docs;
  return [...docs.slice(0, idx), ...docs.slice(idx + 1)];
}

/** Inserts a new Telo.Import document after the last existing Telo.Import,
 *  or immediately after the module doc if no imports exist yet. Keeps
 *  imports grouped together rather than scattered among resources. */
export function addImportDocument(
  docs: Document[],
  name: string,
  source: string,
  extras?: { variables?: Record<string, unknown>; secrets?: Record<string, unknown> },
): Document[] {
  const content: Record<string, unknown> = {
    kind: "Telo.Import",
    metadata: { name },
    source,
  };
  if (extras?.variables) content.variables = extras.variables;
  if (extras?.secrets) content.secrets = extras.secrets;
  const newDoc = new Document(content);

  let insertAt = 0;
  for (let i = 0; i < docs.length; i++) {
    const json = docs[i].toJSON() as { kind?: unknown } | null;
    const kind = json?.kind;
    if (kind === "Telo.Import") {
      insertAt = i + 1;
    } else if (kind === "Telo.Application" || kind === "Telo.Library") {
      if (insertAt <= i) insertAt = i + 1;
    }
  }
  return [...docs.slice(0, insertAt), newDoc, ...docs.slice(insertAt)];
}

/** Removes the Telo.Import document with the given alias name. */
export function removeImportDocument(docs: Document[], name: string): Document[] {
  const idx = findDocForResource(docs, "Telo.Import", name);
  if (idx === undefined) return docs;
  return [...docs.slice(0, idx), ...docs.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// Analyzer + module-creation adapters
// ---------------------------------------------------------------------------

/** Projects a single AST document into the plain-object shape the analyzer
 *  consumes as `ResourceManifest`. The analyzer's own Loader produces the
 *  same shape via `doc.toJSON()`, so this is effectively an alias for that
 *  plus a type cast — the editor-side code was previously reconstructing
 *  from `ParsedManifest` via the custom serializer, which was lossy. */
export function toAnalysisManifest(doc: Document): Record<string, unknown> | null {
  const json = doc.toJSON();
  if (json === null || typeof json !== "object") return null;
  return json as Record<string, unknown>;
}

/** Builds the initial `yaml.Document` for a brand-new module. Kind-specific
 *  body only (no `targets` for Applications, no optional metadata fields) —
 *  mirrors what the editor's legacy renderer emitted for a fresh module so
 *  module-creation output is stable across the serializer switch. */
export function buildInitialModuleDocument(
  kind: "Application" | "Library",
  name: string,
): Document {
  const content = {
    kind: kind === "Application" ? "Telo.Application" : "Telo.Library",
    metadata: { name, version: "1.0.0" },
  };
  return new Document(content);
}
