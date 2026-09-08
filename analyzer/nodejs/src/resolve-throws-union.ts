import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import { scopeResolverForModule, type AliasResolver } from "./alias-resolver.js";
import { resolveScopedName } from "./call-graph.js";
import { refSentinelTarget, type RefSentinelTarget } from "./ref-sentinel-target.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { possibleUses, readRefSlot, transfersControl, type RefSlot } from "./ref-slot.js";
import { readStepSlot } from "./step-slot.js";
import { forEachDrivenSlot } from "./schema-walk.js";

export interface ThrowsCodeMeta {
  data?: Record<string, any>;
}

/** Code a non-`InvokeError` failure surfaces as inside a `catch` block. Mirrors
 *  `PLAIN_ERROR_CODE` in `@telorun/run`'s `toSequenceError`: any invoke can throw
 *  a plain error, which the catch sees as `error.code === "INTERNAL_ERROR"`. */
export const PLAIN_ERROR_CODE = "INTERNAL_ERROR";

export interface ThrowsUnion {
  /** Code → per-code metadata (data schema, etc). Keys are the declared codes. */
  codes: Map<string, ThrowsCodeMeta>;
  /** True when the union cannot be fully resolved statically — e.g. a
   *  `passthrough` call site uses a CEL expression the analyzer can't narrow,
   *  an unknown kind was encountered, or a cycle short-circuited resolution.
   *  Callers must treat unbounded unions as requiring a catch-all entry. */
  unbounded: boolean;
  /** True when the block can fail with a non-`InvokeError` (any `invoke:` step).
   *  Such a failure surfaces inside an enclosing `catch` as `PLAIN_ERROR_CODE`,
   *  so a `throw: { code: "${{ error.code }}" }` rethrow can propagate it. Not
   *  injected into `codes` — only seeds `enclosingTryCodes` at a try/catch site,
   *  leaving non-rethrow unions untouched. */
  canThrowPlain?: boolean;
}

export interface ResolveCtx {
  allManifests: ResourceManifest[];
  defs: DefinitionRegistry;
  aliases: AliasResolver;
  /** Per-imported-library alias resolvers, keyed by module name. A manifest that
   *  originated in an imported library resolves its kind aliases against its own
   *  module's resolver, not the consumer's — an inline handler extracted from an
   *  imported Http.Api inherits the lexical scope of the library that declares it. */
  aliasesByModule: Map<string, AliasResolver>;
  /** The consumer/root module names; resources owned by these resolve against `aliases`. */
  rootModules: Set<string>;
  /**
   * Every imported library's FULL manifest list, keyed by module name.
   *
   * A consumer's flat set holds a library's EXPORTED instances and nothing else,
   * so the siblings an exported entry point invokes are not in it. Without this
   * the walk stops at the first such hop, and the difference is not academic: a
   * library whose entry point raises its own code through an internal guard
   * presented an empty union to its consumer, which then had its `catches:`
   * rejected for the very code the entry point documents.
   *
   * Consulted only as a FALLBACK, after the flat set — the flat set is what the
   * consumer's own resources resolve against, and a library-internal name must
   * never shadow one of them.
   */
  moduleManifests: Map<string, ResourceManifest[]>;
  /** Keyed `<module>\0<name>`: resource names are module-scoped, so two
   *  libraries each declaring a `query` are two different unions. */
  memo: Map<string, ThrowsUnion>;
  inProgress: Set<string>;
}

export function createResolveCtx(
  allManifests: ResourceManifest[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver> = new Map(),
  rootModules: Set<string> = new Set(),
  moduleManifests: Map<string, ResourceManifest[]> = new Map(),
): ResolveCtx {
  return {
    allManifests,
    defs,
    aliases,
    aliasesByModule,
    rootModules,
    moduleManifests,
    memo: new Map(),
    inProgress: new Set(),
  };
}

/**
 * A dispatch target named by a resolved `{kind, name}` ref.
 *
 * The flat set is the scope such a ref was resolved in, so it is asked first;
 * the owning library's own documents are the fallback for a name the flattened
 * view dropped. `kindMatches` applies to BOTH — one function, one rule, or the
 * next caller inherits whichever half it happened to hit.
 */
function findTarget(
  ctx: ResolveCtx,
  name: string,
  ownerModule: string | undefined,
  kindMatches: (m: ResourceManifest) => boolean,
): ResourceManifest | undefined {
  const flat = ctx.allManifests.find((m) => m.metadata?.name === name && kindMatches(m));
  if (flat) return flat;
  if (!ownerModule) return undefined;
  return ctx.moduleManifests
    .get(ownerModule)
    ?.find((m) => m.metadata?.name === name && kindMatches(m));
}

/**
 * The target of a `!ref` that still carries its sentinel — a library-internal
 * reference inside a manifest forwarded into a consumer's flat set, where Phase
 * 2.5 had nothing to resolve it against.
 *
 * **The declaring library is asked FIRST**, and that ordering is the whole rule:
 * a bare name in a library manifest is unambiguously library-internal, so
 * searching the consumer's flat set first let any consumer resource that
 * happened to share the name supply another library's throw union — the same
 * false `{∅}` this branch exists to remove, arrived at from the other side.
 *
 * An ALIAS-qualified source is the cross-module case and is resolved through the
 * declaring module's own alias table, never by dropping the alias and matching
 * the bare name anywhere.
 *
 * Ambiguity resolves to NOTHING rather than to a guess (`resolveScopedName`'s
 * rule), and the caller reads that as unbounded — the safe direction here, since
 * a union that cannot be enumerated must not read as empty.
 */
function findSentinelTarget(
  ctx: ResolveCtx,
  target: RefSentinelTarget,
  ownerModule: string | undefined,
): ResourceManifest | undefined {
  const named = (pool: readonly ResourceManifest[] | undefined): ResourceManifest[] =>
    (pool ?? []).filter((m) => m.metadata?.name === target.name);

  if (target.alias !== undefined && target.alias !== "Self") {
    // A forwarded export: its module is whatever the DECLARING module aliases
    // that prefix to, and it keeps its export name in the flat set.
    // A root-owned manifest resolves aliases against the global table, which is
    // what `scopeResolverForModule` returns undefined for — so fall back to it
    // rather than reading a root's own alias as unresolvable.
    const resolver = scopeResolverFor(ctx, ownerModule) ?? ctx.aliases;
    const module = resolver.moduleForAlias(target.alias);
    if (!module) return undefined;
    return named(ctx.allManifests).find((m) => declaringModuleOf(m) === module);
  }

  const own = named(ctx.moduleManifests.get(ownerModule ?? ""));
  if (own.length === 1) return own[0];
  if (own.length > 1) return undefined;
  return resolveScopedName(named(ctx.allManifests), declaringModuleOf, ownerModule);
}

const declaringModuleOf = (m: ResourceManifest): string | undefined =>
  (m.metadata as { module?: string } | undefined)?.module;

/** Memo key. Module-scoped, because resource names are. */
function memoKey(manifest: ResourceManifest): string | undefined {
  const name = manifest.metadata?.name as string | undefined;
  if (!name) return undefined;
  const mod = (manifest.metadata as { module?: string } | undefined)?.module ?? "";
  return `${mod}\0${name}`;
}

function emptyUnion(): ThrowsUnion {
  return { codes: new Map(), unbounded: false };
}

/** The owning module's alias resolver for a manifest in this resolve context. */
function scopeResolverFor(ctx: ResolveCtx, ownModule: string | undefined): AliasResolver | undefined {
  return scopeResolverForModule(ownModule, ctx.rootModules, ctx.aliasesByModule);
}

function unionInto(target: ThrowsUnion, src: ThrowsUnion): void {
  for (const [code, meta] of src.codes) {
    if (!target.codes.has(code)) target.codes.set(code, meta);
  }
  if (src.unbounded) target.unbounded = true;
  if (src.canThrowPlain) target.canThrowPlain = true;
}

function definitionFor(
  kind: string,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopeResolver?: AliasResolver,
): ResourceDefinition | undefined {
  const direct = defs.resolve(kind);
  if (direct) return direct;
  const scoped = scopeResolver?.resolveKind(kind);
  if (scoped) {
    const d = defs.resolve(scoped);
    if (d) return d;
  }
  const resolved = aliases.resolveKind(kind);
  return resolved ? defs.resolve(resolved) : undefined;
}

function codesFromDefinition(definition: ResourceDefinition): Map<string, ThrowsCodeMeta> {
  const out = new Map<string, ThrowsCodeMeta>();
  const raw = definition.throws?.codes ?? {};
  for (const [code, meta] of Object.entries(raw)) {
    out.set(code, { data: (meta as { data?: Record<string, any> }).data });
  }
  return out;
}

/** Resolve the effective throw union for a named manifest. The result combines
 *  explicit `throws.codes`, `throws.inherit: true` dataflow (step-context
 *  traversal with try/catch subtraction), and unbounded markers for
 *  unresolvable passthrough call sites. Cycles short-circuit to an empty
 *  result so resolution always terminates. */
export function resolveThrowsUnion(
  manifest: ResourceManifest,
  ctx: ResolveCtx,
): ThrowsUnion {
  const name = memoKey(manifest);

  if (name) {
    const cached = ctx.memo.get(name);
    if (cached) return cached;
    if (ctx.inProgress.has(name)) return emptyUnion();
  }

  const ownModule = (manifest.metadata as { module?: string } | undefined)?.module;
  const scopeResolver = scopeResolverFor(ctx, ownModule);
  const definition = definitionFor(manifest.kind, ctx.defs, ctx.aliases, scopeResolver);
  if (!definition) {
    const u: ThrowsUnion = { codes: new Map(), unbounded: true };
    if (name) ctx.memo.set(name, u);
    return u;
  }

  const throws = definition.throws;
  if (!throws) {
    const u = emptyUnion();
    if (name) ctx.memo.set(name, u);
    return u;
  }

  if (name) ctx.inProgress.add(name);
  try {
    const result: ThrowsUnion = { codes: new Map(), unbounded: false };

    for (const [code, meta] of codesFromDefinition(definition)) {
      result.codes.set(code, meta);
    }

    if (throws.passthrough) {
      // Definition-level passthrough can't be resolved without a call site.
      // resolveStepInvokeThrows handles passthrough call sites directly.
      result.unbounded = true;
    }

    if (throws.inherit) {
      const inherited = resolveInherited(manifest, definition, ctx, ownModule);
      unionInto(result, inherited);
    }

    if (name) ctx.memo.set(name, result);
    return result;
  } finally {
    if (name) ctx.inProgress.delete(name);
  }
}

/**
 * `throws.inherit: true` — the union a composer's own STEP BODIES reach.
 *
 * Deliberately steps only, and not every slot the resource drives: `inherit` is
 * a DECLARATION that a kind's union is the union of what it dispatches, and a
 * kind that does not make that claim must not have it inferred — a kind holding
 * a `call` ref it catches internally would silently gain codes it never lets
 * escape. What a CATCH SCOPE needs is a different question with a different
 * answer, and it has its own resolver below.
 */
function resolveInherited(
  manifest: ResourceManifest,
  definition: ResourceDefinition,
  ctx: ResolveCtx,
  ownerModule: string | undefined,
): ThrowsUnion {
  const result: ThrowsUnion = { codes: new Map(), unbounded: false };
  const props = definition.schema?.properties as Record<string, any> | undefined;
  if (!props) return result;

  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    const stepCtx = readStepSlot(fieldSchema);
    if (!stepCtx) continue;
    const steps = (manifest as Record<string, any>)[fieldName];
    if (!Array.isArray(steps)) continue;
    unionInto(result, collectStepArrayThrows(steps, stepCtx.invoke, undefined, ctx, ownerModule));
  }

  return result;
}

/**
 * The union a SCOPE-LEVEL `catches:` list can be asked to render — everything
 * the resource it is written on drives, transitively.
 *
 * `x-telo-catches-for: ""` is itself the claim that this is the denominator, so
 * nothing is inferred from a kind that did not opt in, and no definition has to
 * declare a `throws:` block to carry a catch scope (the kernel forbids one on a
 * `Telo.Service` and a `Telo.Mount`, and rightly: what a router renders is not
 * what a router THROWS).
 *
 * Three edges, three answers. A **step body** contributes its own traversal,
 * subtraction included. A **control-transferring ref** contributes the target's
 * own declared union — a route handler is a leaf here, and asking what IT drives
 * would credit this scope with codes the handler catches internally. A
 * **`throwsThrough` ref** recurses, because the target is another scope on the
 * same ladder: a server renders what its mounts' routes throw, not what the
 * mounts themselves declare.
 */
export function resolveScopeUnion(
  manifest: ResourceManifest,
  definition: ResourceDefinition,
  ctx: ResolveCtx,
  seen: Set<ResourceManifest> = new Set(),
): ThrowsUnion {
  const result: ThrowsUnion = { codes: new Map(), unbounded: false };
  if (seen.has(manifest)) return result;
  seen.add(manifest);
  const ownerModule = (manifest.metadata as { module?: string } | undefined)?.module;

  forEachDrivenSlot(definition.schema, manifest, (driven) => {
    if (driven.kind === "step") {
      unionInto(
        result,
        collectStepArrayThrows(driven.data, driven.slot.invoke, undefined, ctx, ownerModule),
      );
      return;
    }
    if (driven.slot.throwsThrough) {
      const target = resolveRefManifest(driven.data, ctx, ownerModule);
      const targetDef = target
        ? definitionFor(
            target.kind,
            ctx.defs,
            ctx.aliases,
            scopeResolverFor(ctx, (target.metadata as { module?: string } | undefined)?.module),
          )
        : undefined;
      if (target && targetDef) unionInto(result, resolveScopeUnion(target, targetDef, ctx, seen));
      // A target that cannot be resolved says nothing about what it throws, so
      // the scope's union is no longer enumerable.
      else result.unbounded = true;
      return;
    }
    if (!possibleUses(driven.slot).some(transfersControl)) return;
    unionInto(result, resolveRefTargetThrows(driven.data, ctx, ownerModule));
  });

  return result;
}

function collectStepArrayThrows(
  steps: unknown[],
  invokeField: string,
  enclosingTryCodes: Set<string> | undefined,
  ctx: ResolveCtx,
  ownerModule: string | undefined,
): ThrowsUnion {
  const result = emptyUnion();
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    unionInto(
      result,
      collectStepThrows(step as Record<string, any>, invokeField, enclosingTryCodes, ctx, ownerModule),
    );
  }
  return result;
}

/** Walk one step, dispatching by shape. Generic for any Run.Sequence-style
 *  composer: the step keys it recognises (`try` / `catch` / `finally` / `then`
 *  / `else` / `elseif` / `do` / `cases` / `default`) are the same set already
 *  traversed by the analyzer's step-body walk, so future
 *  composers that reuse those shape conventions work without changes here. */
function collectStepThrows(
  step: Record<string, any>,
  invokeField: string,
  enclosingTryCodes: Set<string> | undefined,
  ctx: ResolveCtx,
  ownerModule: string | undefined,
): ThrowsUnion {
  if (step[invokeField]) {
    // Any invoked resource can throw a non-InvokeError at runtime, which an
    // enclosing catch surfaces as PLAIN_ERROR_CODE — record that possibility.
    const u = cloneUnion(
      resolveStepInvokeThrows(step, invokeField, enclosingTryCodes, ctx, ownerModule),
    );
    u.canThrowPlain = true;
    return u;
  }

  if (step.throw && typeof step.throw === "object") {
    return resolveThrowStepCode(step.throw as Record<string, any>, enclosingTryCodes);
  }

  if (Array.isArray(step.try)) {
    const tryUnion = collectStepArrayThrows(step.try, invokeField, enclosingTryCodes, ctx, ownerModule);
    let propagated: ThrowsUnion;
    if (Array.isArray(step.catch)) {
      // Catch absorbs the try block's codes; the catch's own throws propagate
      // out instead. Sequence-specific subtraction — the plan explicitly
      // anchors this to Run.Sequence's try/catch schema shape.
      const tryCodes = new Set(tryUnion.codes.keys());
      // A plain (non-InvokeError) failure in the try block reaches the catch as
      // `error.code === PLAIN_ERROR_CODE`, so a `throw: { code: error.code }`
      // rethrow can propagate it — seed the set the catch resolves against.
      if (tryUnion.canThrowPlain) tryCodes.add(PLAIN_ERROR_CODE);
      propagated = collectStepArrayThrows(step.catch, invokeField, tryCodes, ctx, ownerModule);
      // Unbounded in the try block still signals the caller to expect
      // arbitrary codes to flow through the catch (e.g. via passthrough).
      if (tryUnion.unbounded) propagated.unbounded = true;
    } else {
      propagated = cloneUnion(tryUnion);
    }
    if (Array.isArray(step.finally)) {
      unionInto(
        propagated,
        collectStepArrayThrows(step.finally, invokeField, enclosingTryCodes, ctx, ownerModule),
      );
    }
    return propagated;
  }

  if (Array.isArray(step.then)) {
    const result = emptyUnion();
    unionInto(result, collectStepArrayThrows(step.then, invokeField, enclosingTryCodes, ctx, ownerModule));
    if (Array.isArray(step.else)) {
      unionInto(result, collectStepArrayThrows(step.else, invokeField, enclosingTryCodes, ctx, ownerModule));
    }
    if (Array.isArray(step.elseif)) {
      for (const branch of step.elseif) {
        if (Array.isArray(branch?.then)) {
          unionInto(
            result,
            collectStepArrayThrows(branch.then, invokeField, enclosingTryCodes, ctx, ownerModule),
          );
        }
      }
    }
    return result;
  }

  if (Array.isArray(step.do)) {
    return collectStepArrayThrows(step.do, invokeField, enclosingTryCodes, ctx, ownerModule);
  }

  if (step.cases && typeof step.cases === "object") {
    const result = emptyUnion();
    for (const arr of Object.values(step.cases as Record<string, unknown>)) {
      if (Array.isArray(arr)) {
        unionInto(result, collectStepArrayThrows(arr, invokeField, enclosingTryCodes, ctx, ownerModule));
      }
    }
    if (Array.isArray(step.default)) {
      unionInto(result, collectStepArrayThrows(step.default, invokeField, enclosingTryCodes, ctx, ownerModule));
    }
    return result;
  }

  return emptyUnion();
}

function cloneUnion(u: ThrowsUnion): ThrowsUnion {
  const out = emptyUnion();
  for (const [c, m] of u.codes) out.codes.set(c, m);
  out.unbounded = u.unbounded;
  if (u.canThrowPlain) out.canThrowPlain = true;
  return out;
}

function resolveStepInvokeThrows(
  step: Record<string, any>,
  invokeField: string,
  enclosingTryCodes: Set<string> | undefined,
  ctx: ResolveCtx,
  ownerModule: string | undefined,
): ThrowsUnion {
  return resolveRefTargetThrows(step[invokeField], ctx, ownerModule, () =>
    resolvePassthroughAtCallSite(step, enclosingTryCodes),
  );
}

/**
 * The effective throw union behind a resolved reference value.
 *
 * Shared by both ways a resource drives another: a step's `invoke:` and a
 * reference slot that carries throws. The two used to differ only in where the
 * ref value was read from, and keeping one copy is what stops a router's
 * denominator and a sequence's from disagreeing about what a name resolves to.
 *
 * `onPassthrough` is the one genuine difference: a passthrough kind's union is a
 * property of the CALL SITE (`inputs.code`), which only a step has. A reference
 * slot has no such site, so the union is unbounded there rather than guessed.
 */
function resolveRefTargetThrows(
  refValue: unknown,
  ctx: ResolveCtx,
  ownerModule: string | undefined,
  onPassthrough?: () => ThrowsUnion,
): ThrowsUnion {
  if (!refValue || typeof refValue !== "object" || Array.isArray(refValue)) return emptyUnion();
  const ref = refValue as Record<string, any>;
  const invokedKind = ref.kind as string | undefined;
  // A reference that still carries its parse-time sentinel — a library-internal
  // `!ref` inside a manifest forwarded into a consumer's flat set, where Phase
  // 2.5 had nothing to resolve it against. The target is in the declaring
  // library's own documents, so it is looked up there; only a name that is not
  // there either is UNKNOWN, which is unbounded rather than empty. Reading it as
  // empty is what made a library's exported entry point present a `{∅}` union to
  // its consumer and get the consumer's `catches:` rejected for the code the
  // entry point documents.
  if (!invokedKind) {
    const sentinel = refSentinelTarget(ref);
    if (!sentinel) return emptyUnion();
    const target = findSentinelTarget(ctx, sentinel, ownerModule);
    if (target) return resolveThrowsUnion(target, ctx);
    return { codes: new Map(), unbounded: true };
  }

  // The invoked kind's alias resolves in the OWNER manifest's lexical scope (the
  // resource that declares the slot), so a library's step referencing its own
  // import resolves against that library, not the consumer.
  const scopeResolver = scopeResolverFor(ctx, ownerModule);
  const definition = definitionFor(invokedKind, ctx.defs, ctx.aliases, scopeResolver);
  if (!definition) return { codes: new Map(), unbounded: true };

  if (definition.throws?.passthrough) {
    return onPassthrough ? onPassthrough() : { codes: new Map(), unbounded: true };
  }

  // Named manifest: resolve the full chain (covers transitive inherit).
  const target = resolveRefManifest(ref, ctx, ownerModule);
  if (target) return resolveThrowsUnion(target, ctx);

  // Fall back to the definition's own explicit codes. Mark unbounded when the
  // definition depends on call-site or transitive resolution we couldn't
  // perform (no specific target manifest to recurse into).
  const codes = codesFromDefinition(definition);
  const unbounded =
    definition.throws?.inherit === true || definition.throws?.passthrough === true;
  return { codes, unbounded };
}

/**
 * The manifest a resolved reference value names, in either shape it arrives in —
 * a `{kind, name}` pair, or a `!ref` still carrying its parse-time sentinel.
 *
 * Exported because the catch-scope enclosure walk asks the same question about
 * the same values; resolving a name twice by two rules is how two passes end up
 * disagreeing about which resource a slot points at.
 */
export function resolveRefManifest(
  refValue: unknown,
  ctx: ResolveCtx,
  ownerModule: string | undefined,
): ResourceManifest | undefined {
  if (!refValue || typeof refValue !== "object" || Array.isArray(refValue)) return undefined;
  const ref = refValue as Record<string, any>;
  const kind = ref.kind as string | undefined;
  if (!kind) {
    const sentinel = refSentinelTarget(ref);
    return sentinel ? findSentinelTarget(ctx, sentinel, ownerModule) : undefined;
  }
  const name = ref.name as string | undefined;
  if (!name) return undefined;
  const scopeResolver = scopeResolverFor(ctx, ownerModule);
  const scopedKind = scopeResolver?.resolveKind(kind);
  return findTarget(
    ctx,
    name,
    ownerModule,
    (m) =>
      m.kind === kind ||
      ctx.aliases.resolveKind(m.kind) === kind ||
      m.kind === ctx.aliases.resolveKind(kind) ||
      (scopedKind !== undefined && m.kind === scopedKind),
  );
}

/** Resolve a passthrough-style invocable at a specific call site. Recognised forms
 *  (see "passthrough: true" in the plan):
 *  - constant literal (no template) → `{ <literal> }`
 *  - `${{ 'FOO' }}` constant expression → `{ FOO }`
 *  - `${{ error.code }}` inside a catch → enclosing try's propagated union
 *  Anything else is unbounded; the analyzer flags it downstream. */
function resolvePassthroughAtCallSite(
  step: Record<string, any>,
  enclosingTryCodes: Set<string> | undefined,
): ThrowsUnion {
  return resolveCodeExpression(step.inputs?.code, enclosingTryCodes);
}

/** Resolve the `code:` of a `throw:` step to a throws union. Uses the same
 *  recognised forms as passthrough call sites. */
function resolveThrowStepCode(
  throwSpec: Record<string, any>,
  enclosingTryCodes: Set<string> | undefined,
): ThrowsUnion {
  return resolveCodeExpression(throwSpec.code, enclosingTryCodes);
}

function resolveCodeExpression(
  codeInput: unknown,
  enclosingTryCodes: Set<string> | undefined,
): ThrowsUnion {
  // A `!cel`-tagged sentinel and a `${{ … }}` string must resolve identically —
  // normalize both to the inner CEL expression (or a bare literal code).
  let expr: string;
  if (isTaggedSentinel(codeInput)) {
    if (codeInput.engine !== "cel") return { codes: new Map(), unbounded: true };
    expr = codeInput.source.trim();
  } else if (typeof codeInput === "string" && codeInput.length > 0) {
    const match = codeInput.match(/^\s*\$\{\{\s*([\s\S]+?)\s*\}\}\s*$/);
    if (!match) {
      return { codes: new Map([[codeInput, {}]]), unbounded: false };
    }
    expr = match[1].trim();
  } else {
    return { codes: new Map(), unbounded: true };
  }

  const litMatch = expr.match(/^'([^']+)'$|^"([^"]+)"$/);
  if (litMatch) {
    const code = litMatch[1] ?? litMatch[2]!;
    return { codes: new Map([[code, {}]]), unbounded: false };
  }

  if (expr === "error.code") {
    if (enclosingTryCodes) {
      const codes = new Map<string, ThrowsCodeMeta>();
      for (const c of enclosingTryCodes) codes.set(c, {});
      return { codes, unbounded: false };
    }
    return { codes: new Map(), unbounded: true };
  }

  return { codes: new Map(), unbounded: true };
}
