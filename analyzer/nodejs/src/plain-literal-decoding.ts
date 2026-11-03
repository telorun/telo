import { isTaggedSentinel, schemaConjuncts } from "@telorun/templating";
import {
  decodePlainInteger,
  decodePlainText,
  isCelRecord,
  isCompiledValue,
  isValueTypeSlot,
} from "@telorun/sdk";
import { membersSlotOf, readMembersLiteral } from "./members-value-slot.js";
import {
  collectProperties,
  type ExternalSchemaResolver,
  resolveRefIn,
  selectUnionBranch,
  substituteCelFields,
  type SubstituteOptions,
} from "./schema-compat.js";

/**
 * Decode, IN PLACE, every string literal a resource's config writes at a slot
 * whose value type declares a plain encoding — a timestamp as RFC 3339 text,
 * bytes as base64url — into the instance the slot holds, and every integer
 * literal at a slot whose type declares an integer form (a duration's
 * milliseconds).
 *
 * A YAML literal is one of the places a value arrives from outside Telo, so it
 * is the one place such text is read; the slot holds the instance everywhere
 * else. A slot of a type declaring `members` reads an object of literal members
 * too, built by the same encoding; one holding an expression is built once the
 * expression is evaluated. Text the encoding does not accept is left as written, and the value-type
 * assertion that runs next refuses it, naming the form. Shared by the kernel at
 * resource creation and by `telo check` before validating a resource, so both
 * choose the same union branch, stop at the same reference slots and decode the
 * same leaves.
 *
 * The walk descends only plain containers: a compiled expression, a tagged
 * sentinel and a live instance are not literals, and a reference slot holds a
 * reference. Idempotent — a decoded leaf is no longer a string.
 */
export function decodePlainLiterals(
  value: unknown,
  schema: Record<string, any>,
  external?: ExternalSchemaResolver,
  rootSchema: Record<string, any> = schema,
): unknown {
  return mapTextLeaves(
    value,
    schema,
    decodePlainText,
    external,
    rootSchema,
    undefined,
    composeLiteralMembers,
    decodePlainInteger,
  );
}

/** An object of literal members at a slot of a type declaring them, built — or
 *  undefined, leaving the walk to descend. */
function composeLiteralMembers(schema: Record<string, any>, record: Record<string, unknown>): unknown {
  const slot = membersSlotOf(schema);
  return slot ? readMembersLiteral(slot, record) : undefined;
}

/** What a text leaf becomes, given the schema node it sits at and its JSON
 *  Pointer from the walked value's root. */
export type TextLeafMapper = (schema: Record<string, any>, text: string, pointer: string) => unknown;

/** Sees every node the walk reaches, whatever its type, with the schema node it
 *  sits at — for a question about a slot rather than about its text. */
export type SchemaNodeVisitor = (schema: Record<string, any>, node: unknown, pointer: string) => void;

/** What a number leaf becomes, given the schema node it sits at. */
export type NumberLeafMapper = (schema: Record<string, any>, value: number) => unknown;

/** What a plain record becomes, given the schema node it sits at and its JSON
 *  Pointer — or undefined to descend into it as a container. */
export type RecordMapper = (schema: Record<string, any>, record: Record<string, unknown>, pointer: string) => unknown;

/**
 * The walk {@link decodePlainLiterals} runs, with the leaf rule supplied: every
 * string under `value` is replaced, IN PLACE, by what `leaf` returns for it and
 * the schema node it sits at. The same union branch, the same stops at reference
 * slots, compiled expressions and instances — so a caller asking another
 * question of the text leaves (is this host path absolute?) visits exactly the
 * leaves decoding does. `visit`, when given, is called on every node first;
 * `numeric`, when given, maps every number leaf as `leaf` maps a string.
 */
export function mapTextLeaves(
  value: unknown,
  schema: Record<string, any>,
  leaf: TextLeafMapper,
  external?: ExternalSchemaResolver,
  rootSchema: Record<string, any> = schema,
  visit?: SchemaNodeVisitor,
  record?: RecordMapper,
  numeric?: NumberLeafMapper,
): unknown {
  // A node is read as the conjunction it is: its own keywords and every `allOf`
  // member, each with the document its references resolve against — so a
  // contract node typed by `x-telo-value-schema-from` (an `allOf` of references
  // into the contract's own `$defs`) decodes what its reached types declare.
  const expand = (node: unknown, raw: Record<string, any>, base: Record<string, any>): SchemaPart[] => {
    const entered = resolveRefIn(raw, base, external);
    const selected = selectUnionBranch(entered.schema, node, entered.root, external);
    const here = resolveRefIn(selected, entered.root, external);
    return (
      schemaConjuncts<SchemaPart>(
        here,
        (part) => part.schema,
        (part, member) => {
          if (!member || typeof member !== "object" || Array.isArray(member)) return undefined;
          const read = resolveRefIn(member as Record<string, any>, part.root, external);
          if (typeof read.schema.$ref === "string") return undefined;
          const branch = selectUnionBranch(read.schema, node, read.root, external);
          return resolveRefIn(branch, read.root, external);
        },
      ) ?? [here]
    );
  };

  const walk = (node: unknown, raw: readonly SchemaPart[], pointer: string): unknown => {
    const parts = raw.flatMap((part) => expand(node, part.schema, part.root));
    // The member saying what the value IS — a value type — answers for the slot.
    const slot = parts.find((part) => isValueTypeSlot(part.schema)) ?? parts[0]!;

    visit?.(slot.schema, node, pointer);
    if (typeof node === "string") return leaf(slot.schema, node, pointer);
    if (typeof node === "number" && numeric) return numeric(slot.schema, node);
    if (!node || typeof node !== "object") return node;
    if (parts.some((part) => part.schema["x-telo-ref"] !== undefined)) return node;
    if (isCompiledValue(node) || isTaggedSentinel(node)) return node;

    if (Array.isArray(node)) {
      const items = parts
        .filter((part) => part.schema.items && typeof part.schema.items === "object")
        .map((part) => ({ schema: part.schema.items as Record<string, any>, root: part.root }));
      const each = items.length > 0 ? items : [{ schema: {}, root: slot.root }];
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i], each, `${pointer}/${i}`);
      return node;
    }
    // A branded CEL value — a duration, a uint, a timestamp — is a PLAIN
    // object, so the prototype cannot tell it from a container: it is already
    // the decoded value and descending into its fields would decode its parts
    // against the slot's own schema.
    if (!isCelRecord(node)) return node;
    const mapped = record?.(slot.schema, node as Record<string, unknown>, pointer);
    if (mapped !== undefined) return mapped;
    const entries = node as Record<string, unknown>;
    for (const key of Object.keys(entries)) {
      const children: SchemaPart[] = [];
      for (const part of parts) {
        const additional =
          part.schema.additionalProperties && typeof part.schema.additionalProperties === "object"
            ? (part.schema.additionalProperties as Record<string, any>)
            : undefined;
        const child = collectProperties(part.schema)[key] ?? additional;
        if (child) children.push({ schema: child, root: part.root });
      }
      if (children.length > 0) {
        entries[key] = walk(entries[key], children, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      }
    }
    return node;
  };
  return walk(value, [{ schema, root: rootSchema }], "");
}

/** A schema node with the document its references resolve against. */
interface SchemaPart {
  readonly schema: Record<string, any>;
  readonly root: Record<string, any>;
}

/**
 * {@link substituteCelFields} over `data` as the kernel reads it at a site it
 * decodes — a resource's own config, a slot the derived-slot reader enumerates:
 * its plain-encoded literals decoded first, by the one decoding walk the kernel
 * runs, on a copy, so the caller's manifest is left as written. Decoding is a
 * property of the SITE, so a caller at any other site (a definition's `result:`
 * mapping, which the kernel never decodes) substitutes without it.
 */
export function substituteDecodedCelFields(
  data: unknown,
  schema: Record<string, any>,
  rootSchema: Record<string, any> | undefined,
  options: SubstituteOptions = {},
): unknown {
  const decoded = decodePlainLiterals(
    copyPlainContainers(data),
    schema,
    options.external,
    rootSchema ?? schema,
  );
  return substituteCelFields(decoded, schema, rootSchema, options);
}

/** Arrays and plain objects copied, every other value shared — the containers
 *  decoding writes into. */
export function copyPlainContainers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyPlainContainers);
  if (!value || typeof value !== "object" || isCompiledValue(value) || isTaggedSentinel(value)) {
    return value;
  }
  // Asked of the value DOMAIN, never of the prototype: a branded CEL value is
  // a plain object, and rebuilding one from its entries drops the symbol its
  // brand lives under — silently turning a duration into a pair of numbers.
  if (!isCelRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      copyPlainContainers(item),
    ]),
  );
}
