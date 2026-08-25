/**
 * The single reader of the `x-telo-ref` annotation.
 *
 * A reference slot is *recognised* here and nowhere else. Four surfaces ask what
 * a slot accepts — the analyzer's reference checks, the kernel's Phase-5
 * injection, the GUI editor's reference picker, and `ide-support`'s completions
 * / hover / go-to-definition — and before this module each recognised the
 * annotation by pattern-matching its shape (`typeof node["x-telo-ref"] ===
 * "string"`, plus a hand-rolled `anyOf` peel in three of them, and no peel at all
 * in hover). That is why the shape could not change without silently turning
 * every ref slot in the GUI into a free-text field.
 *
 * Browser-safe by construction: no Node built-ins, so the editor and
 * `ide-support` import it directly and the kernel re-imports it rather than
 * carrying a second reader — the split already used for the invocation-contract
 * resolver, the eval-path matcher and the redaction path parser.
 *
 * Two annotation shapes are accepted during the migration:
 *
 *   x-telo-ref: Telo.Invocable                  # bare string, no declared use
 *   x-telo-ref:                                 # structured
 *     kind: [Telo.Invocable, Telo.Runnable]
 *     use: call
 *     inputs: /inputs
 */

/** How control reaches a slot's target, relative to the declaring resource's own
 *  invocation. The one primitive fact every consumer derives its own semantics
 *  from — see `plans/typed-reference-graph.md`. */
export type RefUse =
  /** Names a shape; no runtime instance exists. No edge of any kind. */
  | "schema"
  /** Held and read; control never transfers. Init-order edge only. */
  | "dependency"
  /** Control transfers during my invocation and returns to me. */
  | "call"
  /** Control transfers during my invocation through the kernel's detach
   *  primitive; I do not await it. */
  | "detached"
  /** I register the target; control reaches it after my invocation, driven by a
   *  request or a timer, and the runtime guarantees a fresh ambient context. */
  | "trigger.inbound"
  /** I register the target; control reaches it when someone drains a value I
   *  returned, so no guarantee holds either way. */
  | "trigger.consumer";

export const REF_USES: readonly RefUse[] = [
  "schema",
  "dependency",
  "call",
  "detached",
  "trigger.inbound",
  "trigger.consumer",
];

export function isRefUse(value: unknown): value is RefUse {
  return typeof value === "string" && (REF_USES as readonly string[]).includes(value);
}

/** True for a use that transfers control to the target at some point. Everything
 *  but `schema` and `dependency`. */
export function transfersControl(use: RefUse): boolean {
  return use !== "schema" && use !== "dependency";
}

/** A slot whose use is selected by a sibling config field. The selector must be
 *  statically resolvable — a literal or a schema default — because a call graph
 *  known only at runtime is not statically analyzable. */
export interface RefUseCases {
  /** JSON Pointer relative to the object ENCLOSING the annotated slot: the
   *  resource root for a resource-level slot, the array item for a slot inside
   *  one. No pointer can reach across an array boundary. */
  by: string;
  /** Selector value (stringified as written in YAML) → the uses that hold. */
  cases: Record<string, RefUse[]>;
}

/** A reference slot's declaration, normalized from every accepted shape. */
export interface RefSlot {
  /** Accepted kinds, unioned across a `kind:` list and across `anyOf` branches.
   *  Canonical `<module>.<Kind>` keys once `resolveSchemaRefKinds` has run;
   *  alias-qualified as authored before that, or the legacy `<ns>/<mod>#<Kind>`
   *  identity form for an already-published module. */
  kinds: string[];
  /** The relations the declaring resource has with the target. A set, because a
   *  slot may dispatch its target more than one way within a single invocation
   *  (`Cache.View` calls inline on a miss and detached on a background
   *  revalidation). Empty when the slot declares no use — the bare-string form,
   *  or a slot that defers to {@link RefSlot.useCases}. */
  uses: RefUse[];
  /** Present when the use is chosen by configuration rather than fixed. */
  useCases?: RefUseCases;
  /** JSON Pointer (same anchoring as {@link RefUseCases.by}) naming the field
   *  that carries this call's arguments. Replaces
   *  `x-telo-topology-role: inputs`. */
  inputs?: string;
  /** `x-telo-inline: true` on the slot or any `anyOf` branch — accepts an inline
   *  `{kind, ...config}` definition, not only a `!ref`. */
  inline: boolean;
  /** The slot's VALUE branches — `anyOf` / `oneOf` alternatives that carry no
   *  `x-telo-ref`, present only when the reference constraint is itself a
   *  *branch* rather than the node's own annotation.
   *
   *  That narrowing is the whole point. A node-level `x-telo-ref` with branches
   *  beneath it (an Application `targets` entry) uses those branches to describe
   *  the POST-RESOLUTION structural forms a reference takes — a bare string
   *  there is the removed string-reference spelling, and admitting it as a value
   *  would retire `INVALID_REFERENCE_FORM` exactly where it still applies. A
   *  branch-level constraint says something different: this slot holds either a
   *  value of one shape or a reference, and a scalar is then a value, not a
   *  malformed reference. */
  valueBranches: Record<string, any>[];
}

/** Every use a slot can take, flattening a case map. The conservative reading
 *  for a consumer that does not resolve the selector. */
export function possibleUses(slot: RefSlot): RefUse[] {
  if (!slot.useCases) return slot.uses;
  const out = new Set<RefUse>(slot.uses);
  for (const uses of Object.values(slot.useCases.cases)) {
    for (const use of uses) out.add(use);
  }
  return [...out];
}

/** True when the slot states what the declaring resource does with the target.
 *  False only for the legacy bare-string form. */
export function hasDeclaredUse(slot: RefSlot): boolean {
  return slot.uses.length > 0 || slot.useCases !== undefined;
}

function normalizeUses(raw: unknown): RefUse[] {
  if (isRefUse(raw)) return [raw];
  if (Array.isArray(raw)) return raw.filter(isRefUse);
  return [];
}

function readUseCases(raw: unknown): RefUseCases | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.by !== "string") return undefined;
  const rawCases = obj.cases;
  if (!rawCases || typeof rawCases !== "object" || Array.isArray(rawCases)) return undefined;
  const cases: Record<string, RefUse[]> = {};
  for (const [key, value] of Object.entries(rawCases as Record<string, unknown>)) {
    cases[key] = normalizeUses(value);
  }
  return { by: obj.by, cases };
}

/** Kind names declared by one annotation value, in either shape. */
function readKinds(annotation: unknown): string[] {
  if (typeof annotation === "string") return annotation ? [annotation] : [];
  if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) return [];
  const kind = (annotation as Record<string, unknown>).kind;
  if (typeof kind === "string") return kind ? [kind] : [];
  if (Array.isArray(kind)) return kind.filter((k): k is string => typeof k === "string" && !!k);
  return [];
}

/** The nodes carrying an `x-telo-ref` for this slot: the node itself plus any
 *  `anyOf` / `oneOf` branch. The multi-kind shape the `kind:` list replaces.
 *
 *  `oneOf` is peeled because the editor's picker always did and the analyzer
 *  never did — unifying on the wider reading is the point of a single accessor.
 *  The no-op claim is scoped to THIS repo: no schema here puts an `x-telo-ref`
 *  under `oneOf`, so for the standard library this cannot add a field-map entry
 *  (and hence a Phase-5 injection site) that did not exist before. An
 *  already-published third-party module that does use that spelling gains an
 *  injection site on upgrade — behavior its author most plausibly intended (the
 *  editor already treated the slot as a reference), but a change of behavior
 *  nonetheless, and part of this release's contract. */
function annotationNodes(node: Record<string, any> | undefined): Record<string, any>[] {
  if (!node || typeof node !== "object") return [];
  const out: Record<string, any>[] = [];
  if (node["x-telo-ref"] !== undefined) out.push(node);
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (branch && typeof branch === "object" && branch["x-telo-ref"] !== undefined) {
        out.push(branch);
      }
    }
  }
  return out;
}

/** The branches of a value-or-reference union — see {@link RefSlot.valueBranches}.
 *  Empty unless the node delegates its reference constraint to a branch. */
function valueBranchesOf(node: Record<string, any> | undefined): Record<string, any>[] {
  if (!node || typeof node !== "object") return [];
  if (node["x-telo-ref"] !== undefined) return [];
  const out: Record<string, any>[] = [];
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    const carriesRef = branches.some(
      (b) => b && typeof b === "object" && b["x-telo-ref"] !== undefined,
    );
    if (!carriesRef) continue;
    for (const branch of branches) {
      if (!branch || typeof branch !== "object") continue;
      if (branch["x-telo-ref"] !== undefined) continue;
      out.push(branch as Record<string, any>);
    }
  }
  return out;
}

/**
 * Reads a schema node as a reference slot, or `undefined` when it declares none.
 *
 * Unions the accepted kinds across the `kind:` list and across `anyOf` branches,
 * which is the model the analyzer has always had internally — `RefFieldEntry`
 * has carried a flat `refs: string[]` since before the structured form existed.
 * A `use` declared on more than one branch is taken once; a *disagreement*
 * between branches is left visible in the returned set rather than silently
 * resolved here, so `validate-ref-slots.ts` reports it against the authored
 * node (`X_TELO_REF_USE_CONFLICT`) — the same split that keeps this reader
 * lenient about unrecognized `use` tokens while that pass rejects them.
 */
export function readRefSlot(node: Record<string, any> | undefined): RefSlot | undefined {
  const nodes = annotationNodes(node);
  if (nodes.length === 0) return undefined;

  const kinds: string[] = [];
  const uses = new Set<RefUse>();
  let useCases: RefUseCases | undefined;
  let inputs: string | undefined;

  for (const carrier of nodes) {
    const annotation = carrier["x-telo-ref"];
    for (const kind of readKinds(annotation)) {
      if (!kinds.includes(kind)) kinds.push(kind);
    }
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) continue;
    const obj = annotation as Record<string, unknown>;
    for (const use of normalizeUses(obj.use)) uses.add(use);
    useCases ??= readUseCases(obj.use);
    if (typeof obj.inputs === "string") inputs ??= obj.inputs;
  }

  const slot: RefSlot = {
    kinds,
    uses: [...uses],
    inline: node?.["x-telo-inline"] === true || nodes.some((n) => n["x-telo-inline"] === true),
    valueBranches: valueBranchesOf(node),
  };
  if (useCases) slot.useCases = useCases;
  if (inputs !== undefined) slot.inputs = inputs;
  return slot;
}

/** True when the node declares a reference slot in any accepted shape. The
 *  recognition test every surface used to spell for itself. */
export function isRefSlot(node: Record<string, any> | undefined): boolean {
  return annotationNodes(node).length > 0;
}

/**
 * Re-emits a slot as a canonical structured annotation value.
 *
 * For a consumer that has to *synthesize* a schema node and keep its reference
 * slot intact — `ide-support` merges `anyOf` branches into one node for
 * completion, and the merged node would otherwise carry no constraint at all,
 * because the branches that held it are gone.
 */
export function refSlotAnnotation(slot: RefSlot): Record<string, unknown> {
  const annotation: Record<string, unknown> = {
    kind: slot.kinds.length === 1 ? slot.kinds[0] : slot.kinds,
  };
  if (slot.useCases) annotation.use = slot.useCases;
  else if (slot.uses.length === 1) annotation.use = slot.uses[0];
  else if (slot.uses.length > 1) annotation.use = slot.uses;
  if (slot.inputs !== undefined) annotation.inputs = slot.inputs;
  return annotation;
}

/**
 * Rewrites every kind name an annotation declares, in place, in whichever shape
 * it is written. `map` returns the replacement, or `undefined` to leave the name
 * untouched (which is what keeps `resolveSchemaRefKinds` idempotent and lets it
 * report an unresolvable constraint while quoting what the author wrote).
 *
 * Lives here rather than in the caller so that adding an annotation shape is a
 * one-file change on the write side as well as the read side.
 */
export function rewriteRefSlotKinds(
  annotationHolder: Record<string, any>,
  map: (kind: string) => string | undefined,
): void {
  const annotation = annotationHolder["x-telo-ref"];
  if (typeof annotation === "string") {
    const next = map(annotation);
    if (next !== undefined) annotationHolder["x-telo-ref"] = next;
    return;
  }
  if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) return;
  const obj = annotation as Record<string, unknown>;
  if (typeof obj.kind === "string") {
    const next = map(obj.kind);
    if (next !== undefined) obj.kind = next;
    return;
  }
  if (Array.isArray(obj.kind)) {
    obj.kind = obj.kind.map((k) => (typeof k === "string" ? (map(k) ?? k) : k));
  }
}
