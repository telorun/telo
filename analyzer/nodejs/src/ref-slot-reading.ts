/**
 * What a `self.<refSlot>` READS as.
 *
 * A ref slot holds the live instance after Phase-5 injection, and the kernel
 * substitutes each one with its last published reading before evaluating a
 * template body (`celSelfView`) — so `self.table.name` and `resources.users.name`
 * name the same fact. This is the static half of that equivalence: without it a
 * ref slot's schema is whatever the kind wrote at the slot (a title, a
 * description and the annotation), which types nothing at all.
 *
 * A published reading has two halves and they are typed differently, exactly as
 * `resources.<name>` is:
 *
 *  - the FLAT half is what `snapshot()` returned, which no manifest declares, so
 *    it stays open. Closing it would reject reads that are correct today, and
 *    there is nothing to close it against.
 *  - `status` is DECLARED (`status:` on the kind, folded along `extends`), so it
 *    is typed and a typo below it is `CEL_UNKNOWN_FIELD`.
 *
 * Deliberately no attempt to type the flat half from the kind's own `schema:`:
 * a snapshot is what the controller chose to publish, not the config it was
 * given, and the two coincide only by convention. Typing one as the other would
 * invent errors on a kind that publishes anything else.
 *
 * Browser-safe: no Node built-ins.
 */
import { effectiveStatusSchema } from "./extends-resolution.js";
import { isRefSlot, readRefSlot } from "./ref-slot.js";

export interface RefReadingScope {
  /** The definition a canonical kind names. */
  resolve(kind: string): Record<string, any> | undefined;
  /** Canonicalizes an alias-qualified kind, for a slot whose constraint has not
   *  been rewritten yet. */
  resolveKind?(kind: string): string | undefined;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The reading schema for one ref slot, or undefined when the slot's constraint
 * resolves to nothing — in which case the slot is left exactly as it was, the
 * degrade-to-today direction every unresolved annotation takes here.
 *
 * A slot constrained to SEVERAL kinds types `status` from the kinds that agree
 * and drops the rest: a read valid against one permitted target must not be
 * rejected because a sibling kind does not declare that field.
 */
export function refSlotReadingSchema(
  slot: Record<string, any>,
  scope: RefReadingScope,
): Record<string, any> | undefined {
  const ref = readRefSlot(slot);
  if (!ref || ref.kinds.length === 0) return undefined;

  const statuses: Record<string, any>[] = [];
  for (const kind of ref.kinds) {
    const canonical = scope.resolveKind?.(kind) ?? kind;
    const definition = scope.resolve(canonical) ?? scope.resolve(kind);
    if (!definition) continue;
    const status = effectiveStatusSchema(definition as any, (k) => scope.resolve(k) as any);
    if (isObject(status) && isObject(status.properties)) statuses.push(status);
  }
  if (statuses.length === 0) return openReading(slot);

  const shared = statuses.length === 1 ? statuses[0]!.properties : sharedProperties(statuses);
  return {
    ...describedBy(slot),
    type: "object",
    additionalProperties: true,
    properties: {
      status: { type: "object", additionalProperties: false, properties: shared },
    },
  };
}

/** Properties every candidate kind declares. A field only some of them report
 *  is not one a read can rely on, and rejecting it would be wrong for the kinds
 *  that do — so it degrades to the open half rather than to an error. */
function sharedProperties(statuses: readonly Record<string, any>[]): Record<string, any> {
  const [first, ...rest] = statuses;
  const out: Record<string, any> = {};
  for (const [name, schema] of Object.entries(first!.properties as Record<string, any>)) {
    if (rest.every((other) => name in (other.properties as Record<string, any>))) {
      out[name] = schema;
    }
  }
  return out;
}

/** A reading whose `status` cannot be typed: open, so nothing new is rejected. */
function openReading(slot: Record<string, any>): Record<string, any> {
  return { ...describedBy(slot), type: "object", additionalProperties: true };
}

/** The slot's own prose, kept so hover and completion still say what it is. */
function describedBy(slot: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  if (typeof slot.title === "string") out.title = slot.title;
  if (typeof slot.description === "string") out.description = slot.description;
  return out;
}

/**
 * Rewrite every ref slot in a kind's own `schema:` to what reading it yields, so
 * the `self` CEL variable answers about published state rather than about the
 * annotation node.
 *
 * A SCHEMA walk, so it recurses through `properties` / `items` /
 * `additionalProperties` and nothing else — there is no inline-declaration
 * boundary to stop at here, because a `kind` key inside a schema is a property
 * NAMED kind, not a nested resource. Untouched subtrees keep their identity, so
 * a schema declaring no ref slot is returned as it was.
 */
export function withRefSlotsAsReadings(
  schema: unknown,
  scope: RefReadingScope,
): unknown {
  if (Array.isArray(schema)) return schema.map((item) => withRefSlotsAsReadings(item, scope));
  if (!isObject(schema)) return schema;

  if (isRefSlot(schema)) return refSlotReadingSchema(schema, scope) ?? schema;

  let changed = false;
  const out: Record<string, any> = { ...schema };
  for (const key of ["properties", "items", "additionalProperties"]) {
    const node = schema[key];
    if (node === undefined) continue;
    const next =
      key === "properties"
        ? mapValues(node, (value) => withRefSlotsAsReadings(value, scope))
        : withRefSlotsAsReadings(node, scope);
    if (next !== node) {
      out[key] = next;
      changed = true;
    }
  }
  return changed ? out : schema;
}

function mapValues(
  node: unknown,
  fn: (value: unknown) => unknown,
): unknown {
  if (!isObject(node)) return node;
  let changed = false;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    const next = fn(value);
    if (next !== value) changed = true;
    out[key] = next;
  }
  return changed ? out : node;
}
