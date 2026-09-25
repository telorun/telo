/**
 * Static validation of the schema-projection annotations themselves — the
 * strict half of the accessor split, mirroring `validate-ref-slots.ts` and
 * `validate-zone-slots.ts`.
 *
 * `readSchemaProjection` / `readSchemaMap` are deliberately lenient: anything
 * they cannot read reads as absent. Without this pass that leniency is silent in
 * the direction that matters — a projection nothing can read does not fail, it
 * simply stops typing the consumers that were counting on it, so a misspelled
 * column reaches the database instead of `telo check`. The whole point of the
 * projection is to move that failure earlier; an unreported malformed
 * declaration puts it back.
 *
 * A map that is merely INCOMPLETE is the same failure per value: a declared type
 * with no entry projects to nothing, so a column of that type silently vanishes
 * from every consumer's view of the row.
 *
 * Scoping follows `X_TELO_REF_UNRESOLVED`: reported only for definitions in the
 * entry's own modules — a published dependency's annotation is not the
 * consumer's to fix.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import {
  collectionEntrySchema,
  projectionCollectionSchema,
  projectionEntryField,
  projectionKeyMap,
  rawSchemaProjection,
  readSchemaProjection,
  SCHEMA_PROJECTION_KEYS,
  schemaMapBranch,
  schemaProjectionIsMisplaced,
  type SchemaProjection,
} from "./schema-projection.js";

export interface SchemaProjectionIssue {
  code: "SCHEMA_PROJECTION_INVALID" | "SCHEMA_MAP_INCOMPLETE";
  manifest: ResourceManifest;
  path: string;
  message: string;
}

const PROJECTION = "x-telo-schema-projection";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validateSchemaProjection(manifest: ResourceManifest): SchemaProjectionIssue[] {
  const doc = manifest as unknown as Record<string, unknown>;
  const raw = rawSchemaProjection(doc);
  if (raw === undefined) return [];

  const misplaced = schemaProjectionIsMisplaced(doc);
  const base = misplaced ? `schema.${PROJECTION}` : PROJECTION;
  const issue = (
    code: SchemaProjectionIssue["code"],
    path: string,
    message: string,
  ): SchemaProjectionIssue => ({ code, manifest, path, message });

  const issues: SchemaProjectionIssue[] = [];
  // Read from both positions so a misplaced annotation still WORKS, and
  // reported so it does not stay misplaced. The alternative — reading only the
  // document — makes the inner spelling silently inert, and the resulting
  // failure surfaces on a consumer's slot as "this kind declares no projection",
  // which blames an author who wrote the annotation correctly enough to mean it.
  if (misplaced) {
    issues.push(
      issue(
        "SCHEMA_PROJECTION_INVALID",
        base,
        `'${PROJECTION}' belongs on the kind DOCUMENT, beside 'schema:', not inside it — ` +
          `it describes the whole declaration rather than one field. It is read from here ` +
          `too, so nothing is broken; move it up a level.`,
      ),
    );
  }

  if (!isObject(raw)) {
    return [
      ...issues,
      issue(
        "SCHEMA_PROJECTION_INVALID",
        base,
        `'${PROJECTION}' must be an object naming the entry collection and the field that keys it.`,
      ),
    ];
  }
  // Closed: a key nothing reads is a modifier the author believes applies and
  // none does — the projection silently types something other than intended.
  for (const key of Object.keys(raw)) {
    if (SCHEMA_PROJECTION_KEYS.includes(key)) continue;
    issues.push(
      issue(
        "SCHEMA_PROJECTION_INVALID",
        `${base}.${key}`,
        `'${PROJECTION}' has no '${key}'. It declares ${SCHEMA_PROJECTION_KEYS.map((k) => `'${k}'`).join(", ")}.`,
      ),
    );
  }
  const missing = ["entries", "key"].filter((field) => typeof raw[field] !== "string");
  if (missing.length > 0) {
    return [
      ...issues,
      issue(
        "SCHEMA_PROJECTION_INVALID",
        base,
        `'${PROJECTION}' is missing ${missing.map((f) => `'${f}'`).join(" and ")}. ` +
          `'entries' is a JSON Pointer to the collection, 'key' the entry field whose value ` +
          `selects an 'x-telo-schema-map' entry.`,
      ),
    ];
  }

  const projection = readSchemaProjection(doc)!;
  const schema = doc.schema;

  // An ARRAY-shaped collection has no key to name its entries by, so without
  // `name` every entry projects to nothing and the whole projection is an object
  // schema with no properties and `additionalProperties: false` — one that
  // rejects every value. A keyed map needs no `name`: the map key IS the
  // identity.
  if (isArrayCollection(projectionCollectionSchema(schema, projection.entries)) && !projection.nameField) {
    return [
      ...issues,
      issue(
        "SCHEMA_PROJECTION_INVALID",
        base,
        `'${PROJECTION}' names '${projection.entries}', which is an array, but declares no ` +
          `'name'. An array's entries have no key, so 'name' must say which field holds an ` +
          `entry's identity — without it the projection yields a schema that rejects every value.`,
      ),
    ];
  }

  const nestedIssue = nestedProblem(raw.nested, schema, projection);
  if (nestedIssue) issues.push(issue("SCHEMA_PROJECTION_INVALID", `${base}.nested`, nestedIssue));

  const reference = raw.reference;
  if (reference !== undefined) {
    if (!isObject(reference)) {
      issues.push(
        issue(
          "SCHEMA_PROJECTION_INVALID",
          `${base}.reference`,
          `'reference' says how an entry whose '${projection.key}' holds a REFERENCE projects. ` +
            `It is an object naming 'from' (the target field to read), 'keyword' (the schema ` +
            `keyword its values become) and one of 'base' / 'baseFrom'.`,
        ),
      );
    } else {
      const absent = ["from", "keyword"].filter((f) => typeof reference[f] !== "string");
      if (absent.length > 0) {
        issues.push(
          issue(
            "SCHEMA_PROJECTION_INVALID",
            `${base}.reference`,
            `'reference' is missing ${absent.map((f) => `'${f}'`).join(" and ")}. Without them a ` +
              `referenced entry projects to nothing, so it vanishes from every consumer's view.`,
          ),
        );
      }
      const bases = ["base", "baseFrom"].filter((f) => reference[f] !== undefined);
      if (bases.length !== 1) {
        issues.push(
          issue(
            "SCHEMA_PROJECTION_INVALID",
            `${base}.reference`,
            bases.length === 0
              ? `'reference' declares neither 'base' nor 'baseFrom', so the projected node has no ` +
                `type. Write 'base' where the named type IS its own base type, or 'baseFrom' ` +
                `naming the target field that holds a value of this kind's own map.`
              : `'reference' declares both 'base' and 'baseFrom'. They are two answers to one ` +
                `question — where the projected node's type comes from — so declare exactly one.`,
          ),
        );
      }
    }
  }

  const map = projectionKeyMap(schema, projection);
  if (!map) {
    return [
      ...issues,
      issue(
        "SCHEMA_PROJECTION_INVALID",
        base,
        `'${PROJECTION}' names '${projection.entries}' keyed on '${projection.key}', but that ` +
          `field carries no 'x-telo-schema-map'. The map declares the JSON Schema each of its ` +
          `values means, and without it the projection types nothing.`,
      ),
    ];
  }

  // An `enum` on the keyed field is the kind's own closed vocabulary, so every
  // member of it is a value the map has to answer for. Only an enum is checked:
  // an open string field has no set to be complete against.
  const field = projectionEntryField(schema, projection, projection.key);
  // The vocabulary may sit on a BRANCH — a slot unioning a closed value set with
  // a reference — and the branch carrying the map is the one whose `enum` the map
  // has to answer for. Asked through the single reader, never re-derived here.
  const keyField = field && (schemaMapBranch(field) ?? field);
  const values = Array.isArray(keyField?.enum) ? (keyField!.enum as unknown[]) : [];
  const unmapped = values.filter((value) => typeof value === "string" && !(value in map));
  if (unmapped.length === 0) return issues;
  return [
    ...issues,
    issue(
      "SCHEMA_MAP_INCOMPLETE",
      base,
      `'x-telo-schema-map' has no entry for ${unmapped.map((v) => `'${v}'`).join(", ")}. ` +
        `An entry declaring an unmapped value projects to nothing, so it disappears from every ` +
        `consumer's view of the shape.`,
    ),
  ];
}

function isArrayCollection(collection: Record<string, unknown> | undefined): boolean {
  return !!collection && isObject(collection.items) && !isObject(collection.additionalProperties);
}

/**
 * Why `nested` cannot recurse, or undefined when it can. It must name an entry
 * field holding a collection whose entries are the SAME shape — inline, or a
 * local `$ref` to it — because the sub-collection is projected with the same
 * key, map and modifiers; any other shape would be read through a vocabulary it
 * does not declare.
 */
function nestedProblem(
  nested: unknown,
  schema: unknown,
  projection: SchemaProjection,
): string | undefined {
  if (nested === undefined) return undefined;
  if (typeof nested !== "string") {
    return `'nested' names the entry field holding a sub-collection of entries, as a string.`;
  }
  const entry = collectionEntrySchema(projectionCollectionSchema(schema, projection.entries), schema);
  const field = projectionEntryField(schema, projection, nested);
  if (!entry || !field) {
    return `'nested' names '${nested}', which the entries of '${projection.entries}' do not declare.`;
  }
  const sub = collectionEntrySchema(field, schema);
  if (!sub || !sameShape(sub, entry)) {
    return (
      `'nested' names '${nested}', which is not a collection of entries shaped like those of ` +
      `'${projection.entries}'. A nested entry is projected with the same key, map and ` +
      `modifiers, so its collection's entries must be the same schema — inline, or a local ` +
      `'$ref' to it.`
    );
  }
  if (isArrayCollection(field) && !projection.nameField) {
    return (
      `'nested' names '${nested}', an array, but the projection declares no 'name' — its ` +
      `entries would have no identity to project under.`
    );
  }
  return undefined;
}

/** Structural equality that terminates on a schema aliased into itself. */
function sameShape(a: unknown, b: unknown, seen = new Map<object, object>()): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameShape(left[key], right[key], seen))
  );
}
