/**
 * The walk behind a resource rule's `reachable: { kind, use, through }`: from a
 * resource, through every slot — and every step `invoke:` target, of use
 * `call` — whose use is in `through`, to every reference of `kind` at a slot
 * of use `use`. Each reference found binds, as `this`, the declaration it
 * names, compared by identity.
 *
 * The traversal is data: the analyzer learns which slots to cross and which to
 * judge from the rule, never from a kind name.
 *
 * Each declaration is walked once, so a cycle in the reference graph ends at its
 * first repeat and the walk is linear in the declarations and slots it reaches.
 * A hop the walk cannot resolve — a reference naming nothing loaded, a library's
 * kind-only `resources:` input, an expression where a reference belongs —
 * fails the whole walk, so the rule is skipped and reported rather than judged
 * over part of what it reaches.
 *
 * Where a finding lands: a reference written in the entry's own modules is
 * reported at that reference; one written in a dependency, at the slot of the
 * entry's own modules where the walk first entered that dependency.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { AccessorBinding } from "./accessor-binding.js";
import type { PeerBindingFailure, RefSite, ReferenceValue } from "./peer-binding.js";
import { navigatePath, referenceValueOf } from "./peer-binding.js";
import type { RefUse } from "./ref-slot.js";
import { isInlineDeclaration } from "./resolved-reference.js";
import { isInjectedDeclaration } from "./resource-input.js";
import { dynamicNode, type ReachableSpec } from "./resource-rule.js";
import { declarationKey } from "./rule-binding-marks.js";
import { accessorSitePaths } from "./rule-declaration-view.js";

/** One step `invoke:` slot of a declaration: its concrete path and what it
 *  dispatches. */
export interface StepSlot {
  readonly path: string;
  readonly kinds: readonly string[];
  readonly uses: readonly RefUse[];
}

/** What the walk reads beyond a binding, supplied by the host holding the
 *  registry and the module scopes. */
export interface ReachEnv {
  /** The canonical kind of a declaration — an inline one read in the scope of
   *  `writer`, the top-level declaration holding it; undefined when the kind
   *  resolves to nothing. */
  canonicalKind(declaration: Record<string, unknown>, writer: ResourceManifest): string | undefined;
  /** Whether canonical `candidate` is `ancestor` or extends it, strictly. */
  isKindOf(candidate: string, ancestor: string): boolean;
  /** Whether `module` is a dependency's rather than one of the entry's own. */
  isDependency(module: string): boolean;
  /** The step `invoke:` slots of a declaration of canonical `kind`, at every
   *  depth of every step body — the call graph's own step recursion. */
  stepSlotsOf(declaration: Record<string, unknown>, kind: string, writer: ResourceManifest): readonly StepSlot[];
}

/** Where a reference the walk found is reported. */
export interface ReachAnchor {
  readonly manifest: ResourceManifest;
  readonly path: string;
}

/** One reference of the rule's kind the walk found. */
export interface ReachedReference {
  /** `this`: the declaration the reference names, bound by identity. */
  readonly value: Record<string, unknown>;
  readonly anchor: ReachAnchor;
  /** Set for a reference a dependency wrote: the declaration reached, as
   *  `<Module>.<name>`, and the reference the walk entered the dependency
   *  through, as written at {@link anchor}. */
  readonly reach?: { readonly reached: string; readonly through: string };
}

export type ReachableResult =
  | { readonly ok: true; readonly references: readonly ReachedReference[] }
  | { readonly ok: false; readonly failure: PeerBindingFailure; readonly anchor?: ReachAnchor };

/** The walk's view of the binder: its resolution and its sites. */
export interface ReachWalkEnv extends ReachEnv {
  view(declaration: ResourceManifest): ResourceManifest;
  /** The declaration a reference names, as a rule reads it. */
  declarationOf(
    reference: ReferenceValue,
    from: { readonly referrer: ResourceManifest; readonly path: string },
  ): ResourceManifest | undefined;
  refSitesOf(declaration: ResourceManifest, kind: string): ReadonlyMap<string, RefSite> | undefined;
  /** Whether a slot refuses the declaration it names. */
  refuses(site: RefSite, declaration: ResourceManifest): boolean;
  /** `value` recorded as the declaration `identity` names, as every binding
   *  records one — once. */
  bind<T extends object>(value: T, identity: string): T;
}

/** One declaration to walk: an inline one is read inside `writer`, at `prefix`. */
interface Visit {
  readonly declaration: Record<string, unknown>;
  readonly writer: ResourceManifest;
  readonly prefix: string;
  /** Where the walk entered the dependency `writer` belongs to. */
  readonly entered?: { readonly anchor: ReachAnchor; readonly hop: ReferenceValue };
}

const moduleOf = (declaration: { metadata?: unknown }): string | undefined => {
  const module = (declaration.metadata as { module?: unknown } | undefined)?.module;
  return typeof module === "string" ? module : undefined;
};

const joinPath = (prefix: string, path: string): string =>
  prefix === "" ? path : path.startsWith("[") ? `${prefix}${path}` : `${prefix}.${path}`;

/** A slot declaring no use is read as a control transfer, as the call graph reads it. */
const usesOf = (uses: readonly RefUse[] | undefined): readonly RefUse[] =>
  uses === undefined || uses.length === 0 ? ["call"] : uses;

export function walkReachable(
  manifest: ResourceManifest,
  kind: string,
  spec: ReachableSpec,
  env: ReachWalkEnv,
): ReachableResult {
  const root = env.view(manifest);
  const references: ReachedReference[] = [];
  const visited = new Set<object>([root]);
  const queue: Visit[] = [{ declaration: root as unknown as Record<string, unknown>, writer: root, prefix: "" }];
  // Whether a slot may hold the rule's kind at all, before anything is resolved.
  const mayHold = (kinds: readonly string[]): boolean =>
    kinds.length === 0 || kinds.some((each) => env.isKindOf(each, spec.kind) || env.isKindOf(spec.kind, each));

  for (let at = 0; at < queue.length; at++) {
    const { declaration, writer, prefix, entered } = queue[at]!;
    const canonical = env.canonicalKind(declaration, writer);
    const declaredKind = at === 0 ? kind : (canonical ?? String(declaration.kind));
    const writerModule = moduleOf(writer);
    const inDependency = writerModule !== undefined && env.isDependency(writerModule);
    const anchorAt = (path: string): ReachAnchor =>
      inDependency && entered ? entered.anchor : { manifest: writer, path };
    const sites = env.refSitesOf(declaration as unknown as ResourceManifest, declaredKind);
    if (!sites) {
      const path = prefix === "" ? String((declaration as { metadata?: { name?: unknown } }).metadata?.name ?? "") : prefix;
      return { ok: false, failure: { reason: "unknown-shape", at: path }, anchor: anchorAt(prefix) };
    }
    const slots: { path: string; site: RefSite }[] = [];
    for (const [path, site] of sites) slots.push({ path, site });
    for (const step of canonical ? env.stepSlotsOf(declaration, canonical, writer) : []) {
      slots.push({ path: step.path, site: { shape: step.path, kinds: step.kinds, uses: step.uses } });
    }

    for (const { path, site } of slots) {
      const uses = usesOf(site.uses);
      const judged = uses.includes(spec.use) && mayHold(site.kinds);
      const walked = uses.some((use) => spec.through.includes(use));
      if (!judged && !walked) continue;
      const raw = readSlot(declaration, path);
      if (raw === NOT_A_REFERENCE) continue;
      const full = joinPath(prefix, path);
      if (raw === UNREADABLE) {
        const anchor = anchorAt(full);
        return { ok: false, failure: { reason: "unknown-shape", at: anchor.path }, anchor };
      }
      const anchor = anchorAt(full);
      const dynamic = dynamicNode(raw, full);
      if (dynamic) return { ok: false, failure: { reason: "dynamic", at: anchor.path, what: dynamic.what }, anchor };

      let target: Record<string, unknown>;
      let targetWriter: ResourceManifest;
      let targetPrefix: string;
      const reference = referenceValueOf(raw);
      if (reference) {
        const named = env.declarationOf(reference, { referrer: writer, path: full });
        if (!named) return { ok: false, failure: { reason: "unresolved", at: anchor.path }, anchor };
        if (isInjectedDeclaration(named)) return { ok: false, failure: { reason: "kind-only", at: anchor.path }, anchor };
        if (env.refuses(site, named)) return { ok: false, failure: { reason: "kind-refused", at: anchor.path }, anchor };
        target = env.bind(named as unknown as Record<string, unknown>, declarationKey(moduleOf(named), named.metadata?.name));
        targetWriter = named;
        targetPrefix = "";
      } else if (isInlineDeclaration(raw)) {
        target = env.bind(raw, declarationKey(writerModule, `${String(writer.metadata?.name ?? "")}#${full}`));
        targetWriter = writer;
        targetPrefix = full;
      } else {
        // Data of another branch of a union holding the slot; any reference
        // inside it is a site of its own.
        continue;
      }

      const targetModule = moduleOf(targetWriter);
      const intoDependency = targetModule !== undefined && env.isDependency(targetModule);
      if (judged && isOfKind(target, targetWriter, site.kinds)) {
        references.push({
          value: target,
          anchor,
          ...(inDependency && entered
            ? { reach: { reached: reachedName(target, targetWriter), through: hopName(entered.hop) } }
            : {}),
        });
      }
      if (walked && !visited.has(target)) {
        visited.add(target);
        const next =
          !intoDependency ? undefined : inDependency ? entered : reference ? { anchor, hop: reference } : entered;
        queue.push({ declaration: target, writer: targetWriter, prefix: targetPrefix, ...(next ? { entered: next } : {}) });
      }
    }
  }
  return { ok: true, references };

  function isOfKind(target: Record<string, unknown>, writer: ResourceManifest, slotKinds: readonly string[]): boolean {
    const declared = env.canonicalKind(target, writer);
    if (declared !== undefined) return env.isKindOf(declared, spec.kind);
    return slotKinds.length > 0 && slotKinds.every((each) => env.isKindOf(each, spec.kind));
  }
}

const NOT_A_REFERENCE = Symbol("not a reference");
const UNREADABLE = Symbol("unreadable");

/**
 * What the slot at `path` of a view holds. An accessor SITE holds the binding a
 * controller receives: a literal's `{ value }` is the value written, and a
 * chain's `{ root, path }` is data read at run time, which names no declaration;
 * anything else there is a value the walk cannot read. Absent and null hold
 * nothing.
 */
function readSlot(declaration: Record<string, unknown>, path: string): unknown {
  const raw = navigatePath(declaration, path);
  if (raw === undefined || raw === null) return NOT_A_REFERENCE;
  if (!accessorSitePaths(declaration).has(path)) return raw;
  if (typeof raw !== "object") return UNREADABLE;
  const binding = raw as AccessorBinding;
  if ("value" in binding) {
    return binding.value === undefined || binding.value === null ? NOT_A_REFERENCE : binding.value;
  }
  return typeof binding.root === "string" && Array.isArray(binding.path) ? NOT_A_REFERENCE : UNREADABLE;
}

/** A reached declaration, named by the module declaring it. */
function reachedName(target: Record<string, unknown>, writer: ResourceManifest): string {
  const module = moduleOf(writer);
  const name = target === (writer as unknown) ? String(writer.metadata?.name ?? "") : `${String(writer.metadata?.name ?? "")} (inline)`;
  return module ? `${module}.${name}` : name;
}

/** A reference as its author wrote it. */
function hopName(hop: ReferenceValue): string {
  return hop.alias !== undefined && hop.alias !== "Self" ? `${hop.alias}.${hop.name}` : hop.name;
}
