/**
 * A LIFTED body walk restricted to one way of deciding it: every
 * {@link Alternatives} node replaced by the option whose choices the witness
 * takes, every list closed up over the items it leaves out, and every record
 * the walk made kept where its holding is taken and moved to the position it
 * stands at — then assembled as {@link expandTemplateBody} assembles a decided
 * walk, so the projection IS that decided expansion.
 *
 * Browser-safe.
 */
import { Alternatives, type ChoiceStep, type Holding } from "./conditioned-expansion.js";
import { resolvedReference, type ResolvedReference } from "./resolved-reference.js";
import {
  assembleTemplateBody,
  TEMPLATE_BODY_FIELDS,
  type HeldRecord,
  type MemberReference,
  type RawMapping,
  type RawTemplateBody,
  type TemplateBodyExpansion,
} from "./template-expansion.js";

type Keys = readonly (string | number)[];

const ABSENT = Symbol("absent");

/** `raw` (a lifted walk) where `holds` says which choice steps are taken. */
export function projectTemplateBody(raw: RawTemplateBody, holds: (step: ChoiceStep) => boolean): TemplateBodyExpansion {
  const taken = (holding: Holding) => holding.path.every(holds);
  const memberRefs = new Map<object, MemberReference>(raw.memberRefs.map((r) => [r.ref, r]));
  const projectedRefs: MemberReference[] = [];
  /** Each list the walk built, by its lifted keys: lifted index → projected. */
  const lists = new Map<string, Map<number, number>>();

  const walk = (value: unknown, lifted: Keys): unknown => {
    if (value instanceof Alternatives) {
      const option = value.options.find((o) => o.path.every(holds));
      return option?.present ? walk(option.value, lifted) : ABSENT;
    }
    if (value === null || typeof value !== "object") return value;
    const member = memberRefs.get(value);
    if (member) {
      const ref: ResolvedReference = resolvedReference(member.ref.kind, member.ref.name, member.ref.alias, member.ref.indexes);
      projectedRefs.push({ ref, name: member.name });
      return ref;
    }
    if (!raw.built.has(value)) return value;
    const origin = raw.built.get(value);
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      const index = new Map<number, number>();
      value.forEach((item, i) => {
        const r = walk(item, [...lifted, i]);
        if (r === ABSENT) return;
        index.set(i, items.length);
        items.push(r);
      });
      lists.set(JSON.stringify(lifted), index);
      const written = Array.isArray(origin) && origin.length === items.length && items.every((v, i) => v === origin[i]);
      return written ? origin : items;
    }
    const record: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const r = walk(field, [...lifted, key]);
      if (r !== ABSENT) record[key] = r;
    }
    return sameRecord(origin, record) ? origin : record;
  };

  const fields: Record<string, unknown> = {};
  let changed = false;
  for (const [key, field] of Object.entries(raw.fields)) {
    if (!TEMPLATE_BODY_FIELDS.includes(key)) {
      fields[key] = field;
      continue;
    }
    const r = walk(field, [key]);
    const written = (raw.definition as Record<string, unknown>)[key];
    if (r === ABSENT) {
      changed = true;
      continue;
    }
    if (r !== written) changed = true;
    fields[key] = r;
  }
  for (const key of TEMPLATE_BODY_FIELDS) {
    if (key in (raw.definition as Record<string, unknown>) && !(key in raw.fields)) changed = true;
  }

  /** A lifted position where the projection holds it. */
  const moved = (keys: Keys): (string | number)[] => {
    const out: (string | number)[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const index = typeof key === "number" ? lists.get(JSON.stringify(keys.slice(0, i))) : undefined;
      if (index === undefined) {
        out.push(key);
        continue;
      }
      const at = index.get(key as number);
      if (at === undefined) {
        throw new Error(`internal: a record of a template body held at '${JSON.stringify(keys)}' lies outside its projection.`);
      }
      out.push(at);
    }
    return out;
  };
  const kept = <T>(records: readonly HeldRecord<T>[], move: (item: T) => T): HeldRecord<T>[] =>
    records.flatMap((r) => (taken(r.holding) ? [{ item: move(r.item), holding: r.holding }] : []));
  const mappings: RawMapping[] = raw.mappings.flatMap((r) =>
    taken(r.holding) ? [{ ...r, item: { ...r.item, from: moved(r.item.from) } }] : [],
  );

  return assembleTemplateBody({
    definition: raw.definition,
    fields,
    changed,
    mappings,
    emitted: kept(raw.emitted, (e) => ({ ...e, at: moved(e.at) })),
    splicedKeys: kept(raw.splicedKeys, (s) => ({ ...s, container: moved(s.container) })),
    literalKeys: kept(raw.literalKeys, (l) => ({ ...l, container: moved(l.container) })),
    members: kept(raw.members, (m) => ({ ...m, member: { ...m.member, at: moved(m.member.at) } })),
    memberRefs: projectedRefs,
    built: new WeakMap(),
  });
}

/** Whether `record` holds exactly what the written `origin` does. */
function sameRecord(origin: unknown, record: Record<string, unknown>): boolean {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
  const keys = Object.keys(origin);
  const own = Object.keys(record);
  return keys.length === own.length && keys.every((k, i) => own[i] === k && record[k] === (origin as Record<string, unknown>)[k]);
}

/** How many nodes a lifted body holds: every container and option. */
export function liftedNodeCount(raw: RawTemplateBody): number {
  let count = 0;
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    count++;
    if (value instanceof Alternatives) {
      for (const option of value.options) {
        count++;
        visit(option.value);
      }
      return;
    }
    for (const field of Object.values(value)) visit(field);
  };
  for (const key of TEMPLATE_BODY_FIELDS) visit((raw.fields as Record<string, unknown>)[key]);
  return count;
}
