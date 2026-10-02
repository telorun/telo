/**
 * The entries a schema's reach records at a slot — a reference, an execution
 * scope, an `x-telo-schema-from` shape — and the predicates that read a value
 * at one (inline declaration or named reference, value branch or reference).
 * WHERE the slots are, and which concrete sites of a resource they reach, is
 * `reference-reach.ts`: the one enumeration every consumer reads.
 */
import { type RefUse, type RefUseCases, readRefSlot } from "./ref-slot.js";
import {
  reachOfSchema,
  valueBranchSchema,
  type ReachPath,
  type ReachRef,
  type SchemaReach,
} from "./reference-reach.js";
import { substituteCelFields } from "./schema-compat.js";
import type { StandIns } from "./stand-in-findings.js";

export { readRefSlot, isRefSlot, hasDeclaredUse } from "./ref-slot.js";
export { refSlotOfEntry } from "./reference-reach.js";
export type { RefSlot, RefUse, RefUseCases } from "./ref-slot.js";

/** An entry for a field that carries one or more x-telo-ref constraints. */
export interface RefFieldEntry {
  /** One or more canonical kind keys ("<module>.<Kind>"), or the deprecated
   *  identity form ("<namespace>/<module>#<Kind>") for a legacy published module.
   *  Multiple entries arise from a `kind:` list or from anyOf branches. */
  refs: string[];
  /** What the declaring resource does with the target — see {@link RefUse}.
   *  Empty for a slot still on the bare-string form. */
  uses: RefUse[];
  /** Set when the use is selected by a sibling config field. */
  useCases?: RefUseCases;
  /** JSON Pointer (relative to the object enclosing the slot) naming the field
   *  carrying this call's arguments. */
  inputs?: string;
  /** True when the field path traversed through at least one array (path contains "[]"). */
  isArray: boolean;
  /** The slot's non-reference alternatives: the node's own union branches (see
   *  {@link RefSlot.valueBranches}) and, at an object-level `anyOf` / `oneOf` at
   *  any depth, the declarations of the same key in the other branches. Whether
   *  a value at a concrete site is one of them is {@link isValueAtSlot}'s. */
  valueBranches?: Record<string, any>[];
  /** x-telo-context schema declared on this ref slot, if any. Describes the CEL invocation
   *  context available to resources placed in this slot. */
  context?: Record<string, any>;
  /** `x-telo-inline: true` — this slot accepts an inline `{kind, ...config}`
   *  definition, not only a `!ref`.
   *
   *  Only meaningful on the *system* kinds (`Telo.Application` and friends),
   *  which are otherwise excluded from inline-resource normalization wholesale.
   *  Ordinary resource kinds accept inline definitions at every ref slot and
   *  need no annotation. The flag exists so `logging.sinks` can opt in without
   *  also legalizing an inline definition in `targets`, where the Application
   *  schema rejects one deliberately — normalization runs upstream of AJV, so
   *  an unconditional opt-in would rewrite the value into a valid shape before
   *  the schema ever saw it. */
  inline?: boolean;
  /** See {@link RefSlot.throwsThrough}. */
  throwsThrough?: boolean;
  /** See {@link RefSlot.outputType}. */
  outputType?: Record<string, any>;
}

/** Everything the throws view records at one field path — the reach's. */
export type DrivenPath = ReachPath;

/** See {@link buildDrivenSlotMap}. */
export type DrivenSlots = SchemaReach;

/** An entry for a field that declares an execution scope (x-telo-scope). */
export interface ScopeFieldEntry {
  /** JSON Pointer(s) (RFC 6901) declaring where x-telo-ref slots within this field can
   *  resolve to the scoped resources. */
  scope: string | string[];
}

/** An entry for a field whose schema is resolved dynamically from a referenced resource's
 *  definition schema (x-telo-schema-from). */
export interface SchemaFromFieldEntry {
  /** Full path expression as written in the schema, e.g.:
   *  - "backend/$defs/NodeOptions"   (relative: sibling x-telo-ref property)
   *  - "/backend/$defs/NodeOptions"  (absolute: root-level x-telo-ref property) */
  schemaFrom: string;
}

/** The half of a definition registry this question needs — structural, so the
 *  field map keeps depending on nothing. */
export interface ValueBranchValidator {
  schemaCompileError(schema: Record<string, any>): string | undefined;
  validateWithRefs(data: unknown, schema: Record<string, any>, standIns?: StandIns): string[];
}

/**
 * True when a value at a ref slot satisfies one of the slot's VALUE branches —
 * a storage class beside a `!ref`, so it is a value and not a malformed
 * reference.
 *
 * One implementation, because BOTH reference passes have to narrow the same way:
 * `validateReferenceForms` would otherwise call it a removed string reference,
 * and `validateReferences` a reference missing `kind` and `name`. Two copies of
 * the rule would eventually disagree about which of the two reported a value.
 *
 * A branch AJV cannot COMPILE is not a branch the value satisfies.
 * `validateWithRefs` returns no issues for one — it swallows the compile failure
 * by design, so one bad schema does not abort the pass — and reading that as
 * "no issues, therefore a value" would switch the reference-form rule off for
 * the slot silently. The uncompilable schema is reported on its own definition
 * by `schemaCompileError`.
 */
export function satisfiesValueBranch(
  value: unknown,
  branches: readonly Record<string, any>[] | undefined,
  registry: ValueBranchValidator,
  /** The stand-ins `value` was substituted with, when it was. */
  standIns?: StandIns,
): boolean {
  if (!branches?.length) return false;
  return branches.some((branch) => {
    const schema = valueBranchSchema(branch);
    return (
      registry.schemaCompileError(schema) === undefined &&
      registry.validateWithRefs(value, schema, standIns).length === 0
    );
  });
}

/**
 * True when the value at a reference site satisfies one of its value branches:
 * a branch of a slot node's own union, or a pattern-level alternative whose
 * union members all accept the concrete value at their union's position.
 *
 * The member condition is JSON Schema's own: a union accepts a value only when
 * the WHOLE object fits one member, so in a discriminated union the rest of the
 * object decides whether a sibling branch's plain value applies at the slot.
 * Expressions in that object stand in as their slot's placeholder, as in every
 * other schema check of a manifest.
 */
export function satisfiesSiteValue(
  value: unknown,
  refs: readonly Pick<ReachRef, "node" | "alternatives">[],
  registry: ValueBranchValidator,
): boolean {
  return refs.some(
    (ref) =>
      satisfiesValueBranch(value, readRefSlot(ref.node)?.valueBranches, registry) ||
      ref.alternatives.some(
        ({ node, members }) =>
          members !== undefined &&
          satisfiesValueBranch(value, [node], registry) &&
          members.every(({ member, document, value: at }) => {
            const standIns: StandIns = new Map();
            const substituted = substituteCelFields(at, member, document, { standIns });
            return satisfiesValueBranch(substituted, [member], registry, standIns);
          }),
      ),
  );
}

/**
 * True when the value at a reference site is a VALUE rather than a reference.
 *
 * A scalar at a slot whose own node unions a value branch is left to that
 * branch, which AJV already judges beside the reference branch. A pattern-level
 * alternative (a sibling `anyOf` / `oneOf` branch giving the key a value) has no
 * such judge — the reference branch beside it constrains nothing AJV sees — so
 * there the value must satisfy a branch itself ({@link satisfiesSiteValue}), or
 * a string fitting no branch would pass as neither.
 */
export function isValueAtSlot(
  value: unknown,
  refs: readonly Pick<ReachRef, "node" | "alternatives">[],
  registry: ValueBranchValidator,
): boolean {
  const nodeUnionsValue = refs.some((ref) => (readRefSlot(ref.node)?.valueBranches.length ?? 0) > 0);
  if (nodeUnionsValue && typeof value !== "object") return true;
  return satisfiesSiteValue(value, refs, registry);
}

/** Keys that a named reference object may have. Values beyond these indicate an inline resource. */
export const REFERENCE_KEYS = new Set(["kind", "name", "metadata"]);

/** True when `val` is an inline resource definition rather than a named reference.
 *  Three shapes flow through here:
 *   - `{kind, name}` (optionally with runtime call args) → named reference, NOT inline.
 *   - `{kind, ...config}` with no name → inline definition with config; extract.
 *   - `{kind}` alone (bare kind, no name) → inline singleton — extract a fresh
 *     stateless resource. Lets simple stateless kinds be used inline without
 *     boilerplate (e.g. `encoder: {kind: Ndjson.Encoder}`, `invoke: {kind: Run.Throw}`).
 *
 *  A named reference (has string `name`) may carry extra keys (e.g. `inputs`)
 *  that are runtime call parameters — those are never inline resources. */
export function isInlineResource(val: Record<string, unknown>): boolean {
  if (typeof val.name === "string") return false;
  if (typeof val.kind !== "string") return false;
  return true;
}

/** The accepted kinds a node declares, unioned across a `kind:` list and across
 *  `anyOf` branches. Thin wrapper over {@link readRefSlot} — kept because
 *  several passes want only the kind set. */
export function collectRefs(node: Record<string, any>): string[] {
  return readRefSlot(node)?.kinds ?? [];
}

/**
 * Every slot through which a resource of this schema DRIVES another — the
 * throws view of the schema's reach (`reference-reach.ts`), the same memoized
 * result for the same schema object. Shared by every throws question (a kind's
 * `inherit` union, a scope list's denominator, catch-scope enclosure, and
 * whether `inherit` is legal at all), so none can reach a slot another cannot.
 */
export function buildDrivenSlotMap(schema: Record<string, any>): DrivenSlots {
  return reachOfSchema(schema);
}
