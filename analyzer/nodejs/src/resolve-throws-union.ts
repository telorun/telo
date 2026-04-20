import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";

export interface ThrowsCodeMeta {
  data?: Record<string, any>;
}

export interface ThrowsUnion {
  /** Code → per-code metadata (data schema, etc). Keys are the declared codes. */
  codes: Map<string, ThrowsCodeMeta>;
  /** True when the union cannot be fully resolved statically — e.g. a
   *  `passthrough` call site uses a CEL expression the analyzer can't narrow,
   *  an unknown kind was encountered, or a cycle short-circuited resolution.
   *  Callers must treat unbounded unions as requiring a catch-all entry. */
  unbounded: boolean;
}

export interface ResolveCtx {
  allManifests: ResourceManifest[];
  defs: DefinitionRegistry;
  aliases: AliasResolver;
  memo: Map<string, ThrowsUnion>;
  inProgress: Set<string>;
}

export function createResolveCtx(
  allManifests: ResourceManifest[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
): ResolveCtx {
  return {
    allManifests,
    defs,
    aliases,
    memo: new Map(),
    inProgress: new Set(),
  };
}

function emptyUnion(): ThrowsUnion {
  return { codes: new Map(), unbounded: false };
}

function unionInto(target: ThrowsUnion, src: ThrowsUnion): void {
  for (const [code, meta] of src.codes) {
    if (!target.codes.has(code)) target.codes.set(code, meta);
  }
  if (src.unbounded) target.unbounded = true;
}

function definitionFor(
  kind: string,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
): ResourceDefinition | undefined {
  const resolved = aliases.resolveKind(kind);
  return defs.resolve(kind) ?? (resolved ? defs.resolve(resolved) : undefined);
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
  const name = manifest.metadata?.name as string | undefined;

  if (name) {
    const cached = ctx.memo.get(name);
    if (cached) return cached;
    if (ctx.inProgress.has(name)) return emptyUnion();
  }

  const definition = definitionFor(manifest.kind, ctx.defs, ctx.aliases);
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
      const inherited = resolveInherited(manifest, definition, ctx);
      unionInto(result, inherited);
    }

    if (name) ctx.memo.set(name, result);
    return result;
  } finally {
    if (name) ctx.inProgress.delete(name);
  }
}

function resolveInherited(
  manifest: ResourceManifest,
  definition: ResourceDefinition,
  ctx: ResolveCtx,
): ThrowsUnion {
  const result: ThrowsUnion = { codes: new Map(), unbounded: false };
  const props = definition.schema?.properties as Record<string, any> | undefined;
  if (!props) return result;

  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    const stepCtx = fieldSchema["x-telo-step-context"] as Record<string, string> | undefined;
    if (!stepCtx?.invoke) continue;
    const steps = (manifest as Record<string, any>)[fieldName];
    if (!Array.isArray(steps)) continue;
    unionInto(result, collectStepArrayThrows(steps, stepCtx.invoke, undefined, ctx));
  }

  return result;
}

function collectStepArrayThrows(
  steps: unknown[],
  invokeField: string,
  enclosingTryCodes: Set<string> | undefined,
  ctx: ResolveCtx,
): ThrowsUnion {
  const result = emptyUnion();
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    unionInto(
      result,
      collectStepThrows(step as Record<string, any>, invokeField, enclosingTryCodes, ctx),
    );
  }
  return result;
}

/** Walk one step, dispatching by shape. Generic for any Run.Sequence-style
 *  composer: the step keys it recognises (`try` / `catch` / `finally` / `then`
 *  / `else` / `elseif` / `do` / `cases` / `default`) are the same set already
 *  traversed by the analyzer's `x-telo-step-context` schema builder, so future
 *  composers that reuse those shape conventions work without changes here. */
function collectStepThrows(
  step: Record<string, any>,
  invokeField: string,
  enclosingTryCodes: Set<string> | undefined,
  ctx: ResolveCtx,
): ThrowsUnion {
  if (step[invokeField]) {
    return resolveStepInvokeThrows(step, invokeField, enclosingTryCodes, ctx);
  }

  if (step.throw && typeof step.throw === "object") {
    return resolveThrowStepCode(step.throw as Record<string, any>, enclosingTryCodes);
  }

  if (Array.isArray(step.try)) {
    const tryUnion = collectStepArrayThrows(step.try, invokeField, enclosingTryCodes, ctx);
    let propagated: ThrowsUnion;
    if (Array.isArray(step.catch)) {
      // Catch absorbs the try block's codes; the catch's own throws propagate
      // out instead. Sequence-specific subtraction — the plan explicitly
      // anchors this to Run.Sequence's try/catch schema shape.
      const tryCodes = new Set(tryUnion.codes.keys());
      propagated = collectStepArrayThrows(step.catch, invokeField, tryCodes, ctx);
      // Unbounded in the try block still signals the caller to expect
      // arbitrary codes to flow through the catch (e.g. via passthrough).
      if (tryUnion.unbounded) propagated.unbounded = true;
    } else {
      propagated = cloneUnion(tryUnion);
    }
    if (Array.isArray(step.finally)) {
      unionInto(
        propagated,
        collectStepArrayThrows(step.finally, invokeField, enclosingTryCodes, ctx),
      );
    }
    return propagated;
  }

  if (Array.isArray(step.then)) {
    const result = emptyUnion();
    unionInto(result, collectStepArrayThrows(step.then, invokeField, enclosingTryCodes, ctx));
    if (Array.isArray(step.else)) {
      unionInto(result, collectStepArrayThrows(step.else, invokeField, enclosingTryCodes, ctx));
    }
    if (Array.isArray(step.elseif)) {
      for (const branch of step.elseif) {
        if (Array.isArray(branch?.then)) {
          unionInto(
            result,
            collectStepArrayThrows(branch.then, invokeField, enclosingTryCodes, ctx),
          );
        }
      }
    }
    return result;
  }

  if (Array.isArray(step.do)) {
    return collectStepArrayThrows(step.do, invokeField, enclosingTryCodes, ctx);
  }

  if (step.cases && typeof step.cases === "object") {
    const result = emptyUnion();
    for (const arr of Object.values(step.cases as Record<string, unknown>)) {
      if (Array.isArray(arr)) {
        unionInto(result, collectStepArrayThrows(arr, invokeField, enclosingTryCodes, ctx));
      }
    }
    if (Array.isArray(step.default)) {
      unionInto(result, collectStepArrayThrows(step.default, invokeField, enclosingTryCodes, ctx));
    }
    return result;
  }

  return emptyUnion();
}

function cloneUnion(u: ThrowsUnion): ThrowsUnion {
  const out = emptyUnion();
  for (const [c, m] of u.codes) out.codes.set(c, m);
  out.unbounded = u.unbounded;
  return out;
}

function resolveStepInvokeThrows(
  step: Record<string, any>,
  invokeField: string,
  enclosingTryCodes: Set<string> | undefined,
  ctx: ResolveCtx,
): ThrowsUnion {
  const invokeRef = step[invokeField];
  if (!invokeRef || typeof invokeRef !== "object") return emptyUnion();
  const invokedKind = invokeRef.kind as string | undefined;
  if (!invokedKind) return emptyUnion();

  const definition = definitionFor(invokedKind, ctx.defs, ctx.aliases);
  if (!definition) return { codes: new Map(), unbounded: true };

  if (definition.throws?.passthrough) {
    return resolvePassthroughAtCallSite(step, enclosingTryCodes);
  }

  // Named manifest: resolve the full chain (covers transitive inherit).
  const invokeName = invokeRef.name as string | undefined;
  if (invokeName) {
    const target = ctx.allManifests.find(
      (m) =>
        m.metadata?.name === invokeName &&
        (m.kind === invokedKind ||
          ctx.aliases.resolveKind(m.kind) === invokedKind ||
          m.kind === ctx.aliases.resolveKind(invokedKind)),
    );
    if (target) return resolveThrowsUnion(target, ctx);
  }

  // Fall back to the definition's own explicit codes. Mark unbounded when the
  // definition depends on call-site or transitive resolution we couldn't
  // perform (no specific target manifest to recurse into).
  const codes = codesFromDefinition(definition);
  const unbounded =
    definition.throws?.inherit === true || definition.throws?.passthrough === true;
  return { codes, unbounded };
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
  if (typeof codeInput !== "string" || codeInput.length === 0) {
    return { codes: new Map(), unbounded: true };
  }

  const match = codeInput.match(/^\s*\$\{\{\s*([\s\S]+?)\s*\}\}\s*$/);
  if (!match) {
    return { codes: new Map([[codeInput, {}]]), unbounded: false };
  }

  const expr = match[1].trim();
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
