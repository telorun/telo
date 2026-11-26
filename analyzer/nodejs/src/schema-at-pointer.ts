/**
 * A place inside a schema document, as a schema of its own that still reads the
 * document: what a validator is handed for a node of a larger schema, so every
 * reference the node writes names what it names where it is written.
 *
 * JSON Schema resolves a `#…` reference against the document's root, never
 * against the node holding it, so a node read out of its document and validated
 * alone would read `#` as itself — a reference that recursed through the
 * document becomes one recursing in place. The node is instead validated where
 * it sits: the document is carried under a reserved `$defs` key, each of its
 * local references rebased onto that place (`slotAtPointer`), and its hoisted
 * fragment definitions beside it at the root, where their pointers resolve.
 *
 * Browser-safe.
 */
import { isHoistedFragmentDefKey, slotAtPointer } from "./manifest-schemas.js";

type Schema = Record<string, any>;

/** The `$defs` key the document is carried under. */
const DOCUMENT_KEY = "telo-within-document";
const DOCUMENT_PLACE = `#/$defs/${DOCUMENT_KEY}`;

const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

const carried = new WeakMap<object, { document: Schema; hoisted: Schema }>();

/** `document` as it is carried: no identity of its own, its local references
 *  rebased onto its place, and its hoisted fragments, which stay at the root. */
function carriedDocument(document: Schema): { document: Schema; hoisted: Schema } {
  let found = carried.get(document);
  if (found) return found;
  // An `$id` would make the carried copy a resource of its own, against which
  // the rebased references would resolve.
  const { $id: _id, $schema: _meta, ...body } = document;
  const hoisted: Schema = {};
  const own: Schema = {};
  for (const [key, value] of Object.entries(isObject(body.$defs) ? body.$defs : {})) {
    if (isHoistedFragmentDefKey(key)) hoisted[key] = value;
    else own[key] = value;
  }
  if (isObject(body.$defs)) {
    if (Object.keys(own).length > 0) body.$defs = own;
    else delete body.$defs;
  }
  found = { document: slotAtPointer(body, DOCUMENT_PLACE), hoisted };
  carried.set(document, found);
  return found;
}

const withinMemo = new WeakMap<object, WeakMap<object, Schema>>();

/**
 * `schema`, every local reference of which is written in `document`, as a schema
 * that compiles on its own and resolves each as `document` does. `schema` is a
 * node of `document`, or composed over nodes of it.
 */
export function schemaWithinDocument(schema: Schema, document: Schema): Schema {
  if (schema === document) return document;
  let byNode = withinMemo.get(document);
  if (!byNode) withinMemo.set(document, (byNode = new WeakMap()));
  const known = byNode.get(schema);
  if (known) return known;
  const { document: body, hoisted } = carriedDocument(document);
  const rebased = slotAtPointer(schema, DOCUMENT_PLACE);
  const ownDefs = isObject(rebased.$defs) ? rebased.$defs : {};
  const out: Schema = { ...rebased, $defs: { ...ownDefs, ...hoisted, [DOCUMENT_KEY]: body } };
  byNode.set(schema, out);
  return out;
}

const atPointerMemo = new WeakMap<object, Map<string, Schema>>();

/**
 * The node at `keys` of `document` (`["properties", "tree"]`) as a schema of its
 * own, read where it sits in `document`; `document` itself for no keys.
 */
export function schemaAtPointer(document: Schema, keys: readonly string[]): Schema {
  if (keys.length === 0) return document;
  // Written as every other reference in a manifest is, unencoded: the readers
  // following a `$ref` take its fragment as a JSON Pointer as written.
  const pointer = keys.map((key) => key.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
  let byPointer = atPointerMemo.get(document);
  if (!byPointer) atPointerMemo.set(document, (byPointer = new Map()));
  const known = byPointer.get(pointer);
  if (known) return known;
  const out = schemaWithinDocument({ $ref: `#/${pointer}` }, document);
  byPointer.set(pointer, out);
  return out;
}
