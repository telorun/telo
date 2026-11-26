/**
 * How a record reads one member named by a literal — the one answer the checker's select,
 * literal index, `.?`, `[?'k']`, `has()` and placement each ask of a record.
 *
 * A declared field is its own type (already met with every pattern matching it). A name
 * declared absent is absent. A name some part's pattern matches is the meet over the parts of
 * each part's matching entries, else that part's `additionalFields` — absent where a matching
 * entry admits no value or the meet cannot hold, placed at the one entry or part that applies
 * and nowhere where several do. Any other name is the record's undeclared members, or none
 * where it is closed.
 */

import type { CelType, RecordType } from "./cel-type.js";
import { partMatches } from "./cel-type.js";
import { meetTypes } from "./json-schema-type.js";
import type { EdgeKey } from "./schema-dependencies.js";
import { ADDITIONAL_EDGE, partAdditionalEdge, patternEdge } from "./schema-dependencies.js";

export interface RecordMemberReading {
  /** The member's type; absent where the record holds no such member. */
  readonly type?: CelType;
  /** Whether the record declares the member to hold no value, rather than not declaring it. */
  readonly absent: boolean;
  /** The member edges the read descends into. */
  readonly edges: readonly EdgeKey[];
  /** The edge the member is placed at, where one alone applies. */
  readonly placed?: EdgeKey;
  /** Types a meet built at the read stands on, read whole: no conversion placed what is beneath them. */
  readonly whole: readonly CelType[];
}

/** One type a part's patterns give a member: a matching entry's, or the part's undeclared members' — absent: no value. */
export interface PatternStanding {
  readonly edge: EdgeKey;
  readonly type?: CelType;
}

const NOTHING_WHOLE: readonly CelType[] = [];

/**
 * What a record's pattern parts give a member no field declares, part by part: each matching
 * entry, else the part's `additionalFields` where it carries one. Nothing where no part's
 * pattern matches the name.
 */
export function patternStanding(record: RecordType, name: string): PatternStanding[] | undefined {
  const matched = partMatches(record, name);
  if (matched === undefined) return undefined;
  const standing: PatternStanding[] = [];
  for (const [part, entries] of matched.entries()) {
    const held = record.patternParts![part]!;
    if (entries.length > 0) {
      for (const at of entries) standing.push({ edge: patternEdge(part, at), ...entryType(held.fields[at]!.type) });
    } else if (held.additionalFields !== undefined) {
      standing.push({ edge: partAdditionalEdge(part), type: held.additionalFields });
    }
  }
  return standing;
}

function entryType(type: CelType | undefined): { type?: CelType } {
  return type === undefined ? {} : { type };
}

export function readRecordMember(record: RecordType, name: string): RecordMemberReading {
  const field = record.fields.get(name);
  if (field !== undefined) return { type: field, absent: false, edges: [name], placed: name, whole: NOTHING_WHOLE };
  if (record.absentFields?.has(name)) return { absent: true, edges: [name], placed: name, whole: NOTHING_WHOLE };
  const standing = patternStanding(record, name);
  if (standing === undefined) {
    const additional = record.additionalFields;
    return additional === undefined
      ? { absent: false, edges: [ADDITIONAL_EDGE], whole: NOTHING_WHOLE }
      : { type: additional, absent: false, edges: [ADDITIONAL_EDGE], placed: ADDITIONAL_EDGE, whole: NOTHING_WHOLE };
  }
  const edges = standing.map((held) => held.edge);
  const empty = standing.find((held) => held.type === undefined);
  if (empty) return { absent: true, edges, placed: empty.edge, whole: NOTHING_WHOLE };
  if (standing.length === 1) return { type: standing[0]!.type!, absent: false, edges, placed: edges[0]!, whole: NOTHING_WHOLE };
  const types = standing.map((held) => held.type!);
  const met = types.slice(1).reduce<CelType | undefined>((held, type) => (held === undefined ? undefined : meetTypes(held, type)), types[0]);
  return met === undefined ? { absent: true, edges, whole: types } : { type: met, absent: false, edges, whole: types };
}

/** Every member a record may hold, with its edge: each field, each part's entries and undeclared members, then its own undeclared members. */
export function recordMembers(record: RecordType): (readonly [EdgeKey, CelType])[] {
  const members: (readonly [EdgeKey, CelType])[] = [...record.fields];
  for (const [part, held] of (record.patternParts ?? []).entries()) {
    for (const [at, entry] of held.fields.entries()) if (entry.type !== undefined) members.push([patternEdge(part, at), entry.type]);
    if (held.additionalFields !== undefined) members.push([partAdditionalEdge(part), held.additionalFields]);
  }
  if (record.additionalFields !== undefined) members.push([ADDITIONAL_EDGE, record.additionalFields]);
  return members;
}

/** Every member edge a record holds, for a read naming no member: each field, each part's entries and undeclared members, its undeclared members. */
export function recordMemberEdges(record: RecordType): EdgeKey[] {
  const edges: EdgeKey[] = [...record.fields.keys()];
  for (const [part, held] of (record.patternParts ?? []).entries()) {
    for (const at of held.fields.keys()) edges.push(patternEdge(part, at));
    if (held.additionalFields !== undefined) edges.push(partAdditionalEdge(part));
  }
  edges.push(ADDITIONAL_EDGE);
  return edges;
}
