import { parseLoadedFile, splitIntegrity, type LoadedFile } from "@telorun/analyzer";
import { defaultCustomTags, isTaggedSentinel } from "@telorun/templating";
import { Document, isDocument, isMap, isNode, isScalar, isSeq, Pair, YAMLMap } from "yaml";
import type { ModuleDocument } from "./model";

/** Parses file text into a ModuleDocument. Wraps the analyzer's
 *  `parseLoadedFile` so the editor and the analyzer Loader produce identical
 *  parse results. */
export function parseModuleDocument(filePath: string, text: string): ModuleDocument {
  return moduleDocumentFromLoaded(filePath, parseLoadedFile(filePath, filePath, text));
}

/** Wrap a `LoadedFile` as a `ModuleDocument`. Used by both
 *  `parseModuleDocument` (text-driven) and the workspace loader (which
 *  receives `LoadedFile`s straight from the analyzer Loader). */
export function moduleDocumentFromLoaded(
  filePath: string,
  loaded: LoadedFile,
): ModuleDocument {
  return { filePath, loaded, dirty: false };
}

/** Concatenated parse-error message, or `undefined` if the file parsed
 *  cleanly. Mirrors the legacy `parseError?: string` field's semantics. */
export function moduleParseError(modDoc: ModuleDocument): string | undefined {
  if (modDoc.loaded.parseErrors.length === 0) return undefined;
  return modDoc.loaded.parseErrors.map((e) => e.message).join("; ");
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
  | { op: "rename"; pointer: string; newKey: string }
  /** Relocate a sequence item within its own sequence. `pointer` names the item
   *  at its CURRENT index; `toIndex` is where it lands. */
  | { op: "move"; pointer: string; toIndex: number }
  /** Relocate a sequence item into a DIFFERENT sequence. `pointer` names the
   *  item at its current index, `toPointer` the destination sequence, `toIndex`
   *  the position it lands at inside it. */
  | { op: "relocate"; pointer: string; toPointer: string; toIndex: number }
  | { op: "setTag"; pointer: string; tag: string | null };

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
        // In-place mutation: preserves Scalar.tag, .comment, .commentBefore.
        node.value = op.value as never;
      } else {
        // Structural replace via setIn drops the tag along with the old node;
        // capture and reapply so explicit `!cel` / `!literal` markers on
        // tagged scalars survive a value-shape change.
        //
        // Not across a sentinel boundary, either way: a sentinel carries its
        // own engine, so `createNode` tags the replacement correctly and
        // reapplying would stamp the OLD engine over it; and where the new
        // value is not one, the tag belonged to the value that just left.
        const crossesSentinel =
          (isScalar(node) && isTaggedSentinel(node.value)) || isTaggedSentinel(op.value);
        const existingTag = !crossesSentinel && isScalar(node) ? node.tag : undefined;
        doc.setIn(path, toYamlNodeIfCollection(doc, op.value));
        if (existingTag) {
          const next = doc.getIn(path, true);
          if (next && isScalar(next)) next.tag = existingTag;
        }
      }
      break;
    }
    case "setTag": {
      const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
      if (!node || !isScalar(node)) {
        throw new Error(
          `applyEdit setTag: target at ${op.pointer} is not a scalar (cannot tag a collection)`,
        );
      }
      if (op.tag === null) {
        // Clearing a tag also unwraps a sentinel value back to its inner
        // source — otherwise the customTag's `identify` would still match
        // on serialize and the tag would re-appear from the value side.
        const v = node.value as { __tagged?: unknown; source?: unknown } | unknown;
        if (v && typeof v === "object" && (v as { __tagged?: unknown }).__tagged === true) {
          node.value = (v as { source?: unknown }).source as never;
        }
        delete (node as { tag?: string }).tag;
      } else {
        node.tag = op.tag;
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
        doc.addIn(path.slice(0, -1), toYamlNodeIfCollection(doc, op.value));
      } else {
        doc.setIn(path, toYamlNodeIfCollection(doc, op.value));
      }
      break;
    }
    case "rename": {
      if (path.length === 0) {
        throw new Error(`applyEdit rename: pointer must target a key (got root)`);
      }
      // The KEY NODE is renamed in place, rather than the entry being deleted
      // and re-set: `setIn` on an absent key APPENDS, so delete-then-set moves
      // the entry to the end of its mapping and re-serializes its value from a
      // plain JS object, losing the author's comments and quote style. Renaming
      // one binding is a one-word edit and has to read as one.
      const parent = doc.getIn(path.slice(0, -1));
      const key = path[path.length - 1];
      const pair = isMap(parent)
        ? parent.items.find((item) => String(isScalar(item.key) ? item.key.value : item.key) === key)
        : undefined;
      // Renaming ONTO an existing key would leave the mapping with two entries
      // of that name — a document no reader agrees about, and one the old
      // delete-then-set spelling could not produce because a set overwrote.
      // Refused here rather than only in the form that happens to be the sole
      // caller today: this is exported as a general operation.
      if (
        isMap(parent) &&
        op.newKey !== key &&
        parent.items.some(
          (item) => String(isScalar(item.key) ? item.key.value : item.key) === op.newKey,
        )
      ) {
        throw new Error(
          `applyEdit rename: ${op.newKey} already exists in the mapping at ${op.pointer}`,
        );
      }
      // A key that is not a plain scalar (or a mapping that is not there) is
      // left alone: the ordinary validators then report the manifest as it is,
      // rather than this silently writing a second entry.
      if (pair && isScalar(pair.key)) pair.key.value = op.newKey;
      break;
    }
    case "move": {
      // The NODE is relocated, not the values rewritten. A reorder expressed as
      // a field diff is positional — `diffArray` walks index by index — so
      // moving one entry emits a `set` for every index in between, rewriting
      // each from plain data. Anything the author attached to an entry rather
      // than to its position (a comment, an anchor, a `!ref` tag, a quote
      // style) would stay where it was while the values slid past it, which is
      // the one outcome that silently means something different.
      const from = path[path.length - 1];
      if (typeof from !== "number") {
        throw new Error(`applyEdit move: pointer must target a sequence index (got ${op.pointer})`);
      }
      const parent = doc.getIn(path.slice(0, -1), true);
      // Not a sequence, or an index that is not there: left alone, so the
      // ordinary validators report the manifest as it is rather than this
      // inventing a position.
      if (!isSeq(parent)) break;
      const items = parent.items as unknown[];
      if (from < 0 || from >= items.length) break;
      // Clamped rather than refused: a drop past the end is a legible gesture
      // meaning "last", and the alternative is a no-op the user reads as a bug.
      const to = Math.max(0, Math.min(op.toIndex, items.length - 1));
      if (to === from) break;
      const [node] = items.splice(from, 1);
      items.splice(to, 0, node);
      break;
    }
    case "relocate": {
      // Dragging a step out of one branch and into another. The same node is
      // carried across for the same reason `move` carries it within one
      // sequence: what the author attached to the ENTRY — a comment, a `!ref`
      // tag, a quote style — belongs to the step, not to where it was sitting.
      // A delete-then-insert would re-serialize it from plain data and lose all
      // three.
      const from = path[path.length - 1];
      if (typeof from !== "number") {
        throw new Error(
          `applyEdit relocate: pointer must target a sequence index (got ${op.pointer})`,
        );
      }
      // BOTH sequences are resolved before either is touched: the destination's
      // own path may run through the source sequence (`/steps/0` into
      // `/steps/1/then`), and removing the item first would shift the index that
      // path is written against. A node reference survives the shift; a path
      // does not.
      // A destination INSIDE the moved node would splice it into its own
      // descendant, producing a cyclic document. The UI guards this too, but the
      // operation is exported as a general one — a caller that has not thought
      // about it must not be able to produce a tree nothing can serialize.
      if (op.toPointer === op.pointer || op.toPointer.startsWith(`${op.pointer}/`)) {
        throw new Error(
          `applyEdit relocate: destination ${op.toPointer} is inside the item being moved`,
        );
      }
      const source = doc.getIn(path.slice(0, -1), true);
      const destination = doc.getIn(jsonPointerToPath(op.toPointer), true);
      if (!isSeq(source) || !isSeq(destination)) break;
      if (source === destination) {
        throw new Error(
          `applyEdit relocate: source and destination are the same sequence — use move`,
        );
      }
      const sourceItems = source.items as unknown[];
      if (from < 0 || from >= sourceItems.length) break;
      const [node] = sourceItems.splice(from, 1);
      const destinationItems = destination.items as unknown[];
      // Clamped, as `move` clamps: a drop past the end reads as "last".
      const to = Math.max(0, Math.min(op.toIndex, destinationItems.length));
      destinationItems.splice(to, 0, node);
      break;
    }
  }

  return [...docs];
}

/** `Document.setIn` / `addIn` treat a plain JS object or array as an opaque
 *  leaf scalar (stored as a `Scalar` whose `.value` is the object itself),
 *  which breaks later descent into that path (`Expected YAML collection at …`).
 *  Wrap objects/arrays via `doc.createNode` so they become real `YAMLMap` /
 *  `YAMLSeq` nodes; primitives (and already-constructed Nodes) pass through. */
function toYamlNodeIfCollection(doc: Document, value: unknown): unknown {
  if (value === null) return value;
  if (typeof value !== "object") return value;
  if (isNode(value) || isDocument(value)) return value;
  return doc.createNode(value);
}

/** True when two JS leaf values have the same primitive type class. Used by
 *  applyEdit to decide between in-place Scalar mutation (preserves comments)
 *  and a full setIn replace (drops the leaf's comment metadata). */
function sameLeafJsType(a: unknown, b: unknown): boolean {
  if (a === null) return b === null;
  if (b === null) return false;
  if (a === undefined || b === undefined) return false;
  // A tagged sentinel is `typeof "object"` like every other object, so the
  // plain type test read `!ref todos` and `{kind: Crud.Resource, …}` as the
  // same shape and swapped the value under the tag — the reference kept its
  // `!ref`, over a value that stringified to `[object Object]`. Whether a leaf
  // is tagged, and by WHICH engine, is part of what it is: a tag is emitted for
  // the value under it, so the two only travel together.
  if (isTaggedSentinel(a) || isTaggedSentinel(b)) {
    return isTaggedSentinel(a) && isTaggedSentinel(b) && a.engine === b.engine;
  }
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
  // Tagged sentinels (`!ref` / `!cel` / `!literal`) are opaque leaves — a
  // single tagged YAML scalar, not a map. Their `{__tagged, engine, source}`
  // JS shape would otherwise be deep-diffed into `set /…/source` ops that
  // destroy the tag (a `!ref foo` scalar has no `source` child node). Treat
  // either side being a sentinel as a wholesale replace. `applyEdit` swaps the
  // scalar value in place, preserving the tag.
  if (isTaggedSentinel(oldVal) || isTaggedSentinel(newVal)) {
    if (!sentinelsEqual(oldVal, newVal)) ops.push({ op: "set", pointer, value: newVal });
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

/** Two sentinels are equal when both their engine and source match; a sentinel
 *  is never equal to a non-sentinel (so a ref→plain-value change emits a set). */
function sentinelsEqual(a: unknown, b: unknown): boolean {
  if (!isTaggedSentinel(a) || !isTaggedSentinel(b)) return false;
  return a.engine === b.engine && a.source === b.source;
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
  return [...docs, newTeloDocument(content)];
}

/**
 * A document whose schema carries the templating tags.
 *
 * `createNode` recognises a `!ref` / `!cel` / `!include-text` value by asking
 * each of the schema's tags to identify it, so a document built with the plain
 * constructor has no way to know one: the sentinel's `{__tagged, engine,
 * source}` JS shape reaches the file as a mapping, and what was a reference
 * parses back as three ordinary keys.
 *
 * Every document the editor creates goes through here, because the values it is
 * given are whatever the author wrote — a resource extracted out of an inline
 * declaration carries that declaration's own references and embeds.
 */
function newTeloDocument(content: unknown): Document {
  return new Document(content, null, { customTags: defaultCustomTags() });
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
  const newDoc = newTeloDocument(content);

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

/** Adds an entry to the owner module doc's inline `imports:` map — the source of
 *  truth for a module's dependencies. Uses the scalar shorthand (`Alias: source`)
 *  when there are no `variables` / `secrets`, else the object form. Mutates the
 *  module doc's AST in place. Returns the same array reference on no-op (no owner
 *  module doc). Mirrors `removeInlineImport` / `setInlineImportSource`. */
export function addInlineImport(
  docs: Document[],
  name: string,
  source: string,
  extras?: { variables?: Record<string, unknown>; secrets?: Record<string, unknown> },
): Document[] {
  const idx = findModuleDocIndex(docs);
  if (idx === -1) return docs;
  const doc = docs[idx];
  // Never overwrite an existing alias: a silent `setIn` would repoint the
  // existing import at a different module, and the manifest would never reach
  // the state that raises DUPLICATE_IMPORT_ALIAS because the edit destroyed it.
  const existing = doc.getIn(["imports", name]);
  if (existing !== undefined) {
    const current =
      typeof existing === "string"
        ? existing
        : (doc.getIn(["imports", name, "source"]) as string | undefined) ?? "another module";
    throw new Error(
      `Import alias "${name}" already exists in this module (currently ${current}). Choose a different alias.`,
    );
  }
  if (extras?.variables || extras?.secrets) {
    const entry: Record<string, unknown> = { source };
    if (extras.variables) entry.variables = extras.variables;
    if (extras.secrets) entry.secrets = extras.secrets;
    doc.setIn(["imports", name], entry);
  } else {
    doc.setIn(["imports", name], source);
  }
  return [...docs];
}

/** Removes the Telo.Import document with the given alias name. */
export function removeImportDocument(docs: Document[], name: string): Document[] {
  const idx = findDocForResource(docs, "Telo.Import", name);
  if (idx === undefined) return docs;
  return [...docs.slice(0, idx), ...docs.slice(idx + 1)];
}

/** Index of the owner module doc (Telo.Application / Telo.Library), or -1. */
function findModuleDocIndex(docs: Document[]): number {
  for (let i = 0; i < docs.length; i++) {
    const kind = (docs[i].toJSON() as { kind?: unknown } | null)?.kind;
    if (kind === "Telo.Application" || kind === "Telo.Library") return i;
  }
  return -1;
}

/** Removes an inline `imports:` map entry (alias key) on the owner module doc,
 *  mutating its AST in place. Drops a now-empty `imports:` map. Returns the same
 *  array reference on no-op (no module doc / no such inline entry) so callers can
 *  detect a no-op by identity, mirroring `removeImportDocument`. */
export function removeInlineImport(docs: Document[], name: string): Document[] {
  const idx = findModuleDocIndex(docs);
  if (idx === -1) return docs;
  const doc = docs[idx];
  if (!doc.hasIn(["imports", name])) return docs;
  doc.deleteIn(["imports", name]);
  const imports = doc.getIn(["imports"], true);
  if (imports && isMap(imports) && imports.items.length === 0) {
    doc.deleteIn(["imports"]);
  }
  return [...docs];
}

/** Widens inline `imports:` entries written in the scalar shorthand
 *  (`Alias: <source>`) into the object form (`Alias: {source: <source>}`), for
 *  the named aliases only. Returns the same array reference on no-op.
 *
 *  A shorthand entry is a Scalar node, so it has nothing to write a key into:
 *  `setIn(["imports", alias, "variables"], …)` throws `Expected YAML
 *  collection`. Any edit adding a sibling to `source` therefore has to widen the
 *  entry first — which is why this is a separate step rather than something the
 *  generic op applier could infer, since only imports know that the shorthand's
 *  scalar stands for `source`.
 *
 *  The existing Scalar node becomes the `source:` value rather than being
 *  re-created from its data, so its quote style and its own comment travel with
 *  it, exactly as `setInlineImportSource` preserves them when swapping a value. */
export function expandInlineImportShorthand(docs: Document[], names: string[]): Document[] {
  const idx = findModuleDocIndex(docs);
  if (idx === -1) return docs;
  const doc = docs[idx];
  let changed = false;
  for (const name of names) {
    const entry = doc.getIn(["imports", name], true);
    if (!entry || !isScalar(entry)) continue;
    const widened = new YAMLMap();
    widened.add(new Pair(doc.createNode("source"), entry));
    doc.setIn(["imports", name], widened);
    changed = true;
  }
  return changed ? [...docs] : docs;
}

/** Rewrites the `source` of an inline `imports:` map entry in place, handling
 *  both the scalar shorthand (`Alias: source`) and the object form
 *  (`Alias: { source, ... }`) — the object form keeps its `variables` /
 *  `secrets` / `runtime`. Returns the same array reference on no-op.
 *
 *  `newSource` is the FOLDED form: the ref with the new version's pin already
 *  attached as a `#sha256-…` fragment, or no pin at all when none is available.
 *  Where that pin physically lands follows the shape the author chose — an entry
 *  that carried an `integrity:` sibling keeps it, everything else carries the
 *  fragment inside `source`. Same rule the VS Code lens applies, so the two
 *  upgrade paths leave a file in the same shape.
 *
 *  With no pin in `newSource` a stale `integrity:` sibling is deleted rather
 *  than carried over: it hashes the `telo.yaml` of the version being replaced,
 *  so keeping it turns the next install into a tamper error. */
export function setInlineImportSource(
  docs: Document[],
  name: string,
  newSource: string,
): Document[] {
  const idx = findModuleDocIndex(docs);
  if (idx === -1) return docs;
  const doc = docs[idx];
  if (!doc.hasIn(["imports", name])) return docs;
  const entry = doc.getIn(["imports", name], true);
  if (entry && isMap(entry)) {
    if (entry.has("integrity")) {
      const { base, integrity } = splitIntegrity(newSource);
      doc.setIn(["imports", name, "source"], base);
      if (integrity) doc.setIn(["imports", name, "integrity"], integrity);
      else entry.delete("integrity");
    } else {
      doc.setIn(["imports", name, "source"], newSource);
    }
  } else if (entry && isScalar(entry)) {
    // Preserve the scalar node (and any comment) — only swap its value.
    entry.value = newSource;
  } else {
    doc.setIn(["imports", name], newSource);
  }
  return [...docs];
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
  return newTeloDocument(content);
}
