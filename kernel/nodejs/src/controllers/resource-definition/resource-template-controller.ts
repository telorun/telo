import type {
  CompiledValue,
  ControllerInstance,
  EvaluationContext,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import {
  celEvalSites,
  effectiveAuthorSchema,
  evalPathCovers,
  mergeCelEvalSites,
  NO_CEL_EVAL_SITES,
  pathMatchesScope,
  type CelEvalSites,
} from "@telorun/analyzer";
import { isCompiledValue, type ResourceDefinition } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { celSelfView } from "../../evaluation-context.js";

/**
 * WHICH NODES OF A TEMPLATE BODY SURVIVE init() UNEXPANDED.
 *
 * A `resources:` entry is a DECLARATION of another kind, and that kind decides
 * when each of its fields is evaluated: an `x-telo-eval: runtime` field, or any
 * field under a CEL-bearing region (an `x-telo-context`, an error branch, a step
 * body), is evaluated by the child's OWN controller against a scope only it can
 * build. Those nodes must reach the child compiled.
 *
 * Read off the nested kind's schema through the containment matcher both halves
 * already share (`celEvalSites` / `evalPathCovers`), never off a list of
 * variable names. The name list — `request`, `result`, `steps`, `error` — was
 * the reason a body could not read the call's own arguments (`inputs`) or an
 * iteration's element (`item`): those two names were simply absent from it, so
 * such a node was expanded at init() against a scope where they do not exist and
 * failed with `Unknown variable: inputs`. A list has to be extended for every
 * name any kind ever binds; the annotations already say where evaluation
 * happens.
 */
/** True when a node at `path` inside a body is evaluated by the child's own
 *  controller rather than at the template's init(). `runtime` paths are
 *  property-only and match by containment; a region scope is a JSONPath
 *  (`$.routes[*].returns`) whose wildcards a plain prefix test cannot resolve. */
function isDeferredPath(sites: CelEvalSites, path: string): boolean {
  return (
    sites.runtime.some((p) => evalPathCovers(p, path)) ||
    sites.regions.some((scope) => pathMatchesScope(path, scope))
  );
}

/**
 * True when an expression reads anything other than `self`. A deferred node that
 * names only `self` is still resolved at `init()`: `self` is fixed for the life
 * of the instance, so expanding it there costs nothing and keeps a `self`-built
 * literal (a SQL string, a route path) a literal.
 *
 * Read off the AST-derived roots the compile step stamps, never off the source
 * text. A regex over the source both over- and under-matches — it fires on a
 * word inside a string literal and misses a bare `${{ item }}` with no member
 * access — and there is nothing to fall back FOR: every built-in engine carries
 * `refs` through. An engine that surfaces none is treated as reading nothing but
 * `self`, which resolves it at `init()` and fails loudly there rather than
 * silently deferring a node the child cannot evaluate.
 */
function referencesBeyondSelf(value: CompiledValue): boolean {
  return (value.refs ?? []).some((r) => r !== "self");
}

/** Matches a CEL source that is exactly a `self.<path>` member access (capturing
 *  the `.<path>` tail) — the form resolved by direct navigation rather than CEL. */
const SELF_PATH = /^self((?:\.[A-Za-z_$][\w$]*)+)$/;

/** Reports the resources: entries available to dispatch against, by expanded
 *  name and kind. Used in error messages to guide the developer back to the
 *  template's `resources:` array when a dispatch target doesn't match. */
function describeAvailableTargets(
  ctx: EvaluationContext,
  resources: any[] | undefined,
  self: Record<string, unknown>,
): string {
  if (!resources || resources.length === 0) return "<none>";
  return resources
    .map((r) => {
      const expanded = ctx.expandWith(r?.metadata?.name ?? "", { self }) as string;
      const kind = typeof r?.kind === "string" ? r.kind : "<unknown-kind>";
      return `'${expanded || "<unnamed>"}' (${kind})`;
    })
    .join(", ");
}

export function createTemplateController(definition: {
  schema: Record<string, any>;
  resources?: any[];
  invoke?: string | { kind?: string; name: string };
  inputs?: Record<string, any>;
  run?: string;
  mount?: string | { kind?: string; name: string };
  provide?: { kind: string; name: string };
  result?: Record<string, any>;
}, definingContext: EvaluationContext): ControllerInstance {
  return {
    create: async (resource: any, ctx: ResourceContext): Promise<ResourceInstance> => {
      // `self` is read lazily: Phase 5 injection mutates `resource`'s ref slots
      // (e.g. `connection: !ref Db` → the live instance) AFTER create() but before
      // init(), so capturing self here would freeze the pre-injection refs. Every
      // expansion reads the current resource state instead.
      const getSelf = () => ({ ...resource, name: resource.metadata.name });

      // A dispatch field names which `resources:` entry receives the call. It is
      // a string name template (legacy shorthand) or an object `{ kind?, name }`
      // for explicit kind-typed dispatch. Per-call data lives on the top-level
      // `inputs:` sibling (same factoring as Run.Sequence steps), never in the
      // target's resource body — the body is `self`-only so every child can be
      // created once at init and reused across calls.
      const targetName = (
        field: string | { kind?: string; name: string } | undefined,
      ): string | null => {
        if (field == null) return null;
        // `invoke: !ref body` names a sibling `resources:` entry — the same
        // spelling every other reference uses. Phase 2.5 does not descend into a
        // `Telo.Definition`, so the sentinel arrives raw; `Self.` is the
        // explicit self-qualifier and names the same local entry.
        if (isRefSentinel(field)) {
          const source = field.source;
          return source.startsWith("Self.") ? source.slice("Self.".length) : source;
        }
        const nameTemplate =
          typeof field === "object" && !isCompiledValue(field) ? field.name : field;
        return nameTemplate
          ? (definingContext.expandWith(nameTemplate, { self: getSelf() }) as string)
          : null;
      };

      const invokeTarget = targetName(definition.invoke);
      const runTarget = targetName(definition.run);
      const mountTarget = targetName(definition.mount);
      const provideTarget = targetName(definition.provide);

      // The child scope is rooted on definingContext (so the template's internal
      // kinds/refs resolve against the defining library). Its *ownership*, though,
      // is this instance: stamp the child with the owning resource so the
      // resources it spawns carry a hierarchical id (`<owner.id>/<kind>.<name>`)
      // and an `owner` pointer. That keeps two instances of the same templated
      // kind from colliding by name and lets a debug consumer nest them under
      // their parent. `ctx.ownerPrefix` makes the id robust when templates nest.
      const childContext = definingContext.spawnChildContext();
      childContext.owner = {
        kind: resource.kind,
        name: resource.metadata.name,
        id: `${ctx.ownerPrefix}${resource.kind}.${resource.metadata.name}`,
      };

      // Resolves the live instance of a dispatch target from the child context.
      // Every `resources:` entry is a persistent child created once at init(),
      // so the target is looked up — never re-created — per call.
      const dispatchEntry = (target: string, role: string) => {
        const entry = childContext.resourceInstances.get(target);
        if (!entry) {
          throw new Error(
            `Template '${resource.metadata.name}': '${role}:' targets '${target}' ` +
              `but no entry in 'resources:' has that metadata.name. Available: ${describeAvailableTargets(definingContext, definition.resources, getSelf())}.`,
          );
        }
        return entry;
      };

      const capabilityError = (entry: any, target: string, role: string, expected: string): Error => {
        const targetKind = (entry?.resource?.kind ?? "<unknown-kind>") as string;
        const targetDef = definingContext.getDefinition?.(targetKind);
        const actualCap = typeof targetDef?.capability === "string" ? targetDef.capability : "<unknown>";
        return new Error(
          `Template '${resource.metadata.name}': '${role}:' target '${targetKind}/${target}' ` +
            `has capability '${actualCap}', not ${expected}. Update '${role}:' to a ${expected} kind, ` +
            `or change the target's kind in 'resources:'.`,
        );
      };

      const expand = (value: any, extra: Record<string, unknown>) =>
        definingContext.expandWith(definingContext.expandWith(value, extra), extra);

      // A local `!ref` inside a template body names a sibling `resources:` entry.
      // The entry carries the kind, so resolve each sibling's expanded name to its
      // kind — used to stamp the ref's `{kind, name}` injection shape (an empty
      // kind is rejected downstream as a malformed inline resource).
      const siblingKinds = new Map<string, string>();
      for (const template of definition.resources ?? []) {
        const expandedName = definingContext.expandWith(template?.metadata?.name ?? "", {
          self: getSelf(),
        }) as string;
        if (expandedName && typeof template?.kind === "string") {
          siblingKinds.set(expandedName, template.kind);
        }
      }

      // Expand a persistent child's body against `self`. Self-only CEL resolves
      // to literals now; a node the NESTED KIND evaluates later (see
      // `deferredPaths`) passes through compiled for the child's own controller. `!ref` sentinels are
      // rewritten to the `{kind, name, alias?}` injection shape here — Phase 2.5
      // (`resolveRefSentinels`) does not descend into template bodies, so the
      // child context's Phase 5 injection would otherwise see an unrecognized
      // sentinel and leave the slot unresolved. Kind is left empty: injection
      // dispatches by name and recovers the kind from the resolved instance.
      const expandSelf = (value: any, path: string, deferred: CelEvalSites): any => {
        if (isCompiledValue(value)) {
          if (isDeferredPath(deferred, path) && referencesBeyondSelf(value)) return value;
          // A pure `self.<path>` access (e.g. a `connection: !ref` passed down) is
          // resolved by navigating the resource directly. Going through CEL would
          // re-emit the value through CEL's output type-checker, which rejects live
          // resource instances (unrecognized class constructors) — so the connection
          // a consumer wired in could never reach a child's slot. Complex self
          // expressions (string building) still evaluate via CEL, where they yield
          // CEL-safe scalars.
          const selfPath =
            typeof value.source === "string" ? value.source.trim().match(SELF_PATH) : null;
          if (selfPath) {
            let cur: any = getSelf();
            for (const key of selfPath[1]!.split(".").slice(1)) cur = cur?.[key];
            return cur;
          }
          // CEL cannot read a member off a live instance, and a ref slot holds
          // one after Phase-5 injection. `celSelfView` replaces each with its
          // published reading, so `self.<ref>.<field>` answers exactly as
          // `resources.<name>.<field>` does. The pure-`self.<path>` form above
          // is navigated directly and still yields the instance itself, which is
          // what a ref slot passed straight through (`connection:`) needs.
          return definingContext.expandWith(value, { self: celSelfView(getSelf()) });
        }
        if (isRefSentinel(value)) {
          const source = value.source;
          const dot = source.indexOf(".");
          const alias = dot > 0 ? source.slice(0, dot) : undefined;
          if (alias && alias !== "Self") {
            const name = source.slice(dot + 1);
            return { kind: siblingKinds.get(name) ?? "", name, alias };
          }
          const name = alias === "Self" ? source.slice(dot + 1) : source;
          return { kind: siblingKinds.get(name) ?? "", name };
        }
        if (Array.isArray(value)) {
          return value.map((item, i) => expandSelf(item, `${path}[${i}]`, deferred));
        }
        if (value !== null && typeof value === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value)) {
            out[k] = expandSelf(v, path ? `${path}.${k}` : k, deferred);
          }
          return out;
        }
        return value;
      };

      /**
       * The nested kind's own CEL evaluation sites, resolved once per body. The
       * kind is written in the DEFINING library's alias scope, so it is
       * resolved there — the consumer has never heard of the alias.
       *
       * The INHERITANCE-RESOLVED schema, merged with the capability abstract's,
       * exactly as the analyzer half reads it (`effectiveSchemaOf` in
       * `cel-scope.ts`). A nested kind that inherits a CEL region from an
       * `extends` parent — or gets one implicitly from `Telo.Provider` — would
       * otherwise be covered on the static side and not here, which is the two
       * halves disagreeing about when a node is evaluated.
       */
      const deferredPathsFor = (kind: unknown): CelEvalSites => {
        if (typeof kind !== "string") return NO_CEL_EVAL_SITES;
        const cached = deferredByKind.get(kind);
        if (cached) return cached;
        const resolveDef = (k: string): ResourceDefinition | undefined =>
          definingContext.getDefinition?.(definingContext.kindResolver?.(k) ?? k) ??
          definingContext.getDefinition?.(k);
        const def = resolveDef(kind);
        const capability = def?.capability;
        const sites = def
          ? mergeCelEvalSites(
              celEvalSites(effectiveAuthorSchema(def, resolveDef) as Record<string, any>),
              celEvalSites(
                (capability ? resolveDef(capability)?.schema : undefined) as
                  | Record<string, any>
                  | undefined,
              ),
            )
          : NO_CEL_EVAL_SITES;
        deferredByKind.set(kind, sites);
        return sites;
      };

      // init() may run more than once: when a child's local ref names a sibling
      // not yet initialized, child init defers with ERR_LOCAL_REF_PENDING and the
      // outer multi-pass loop retries this resource. Registration must happen
      // once; each retry only resumes the child init loop (already-initialized
      // children are skipped, still-pending ones advance).
      let registered = false;

      /** Memo per nested kind — a body is expanded once, but a template kind is
       *  instantiated many times across an application. */
      const deferredByKind = new Map<string, CelEvalSites>();

      return {
        // The template's own resources are its allocation, and tearing the child
        // context down is the inverse. `init()` still resumes rather than
        // restarting, because a deferral (a child ref naming a sibling that has
        // not initialized) keeps the instance: only a real failure discards it.
        init: (templateCtx) =>
          templateCtx.effect("template resources", async () => {
            if (!registered) {
              // `self` is in scope for the whole body, not only for what init()
              // resolves: a node the nested kind evaluates later (a step's
              // `inputs`, a route's `returns`) may read `self` beside the
              // call-time names its own controller binds. Bound as the
              // published-reading view, so `self.<ref>.<field>` answers exactly
              // as `resources.<name>.<field>` does.
              childContext.bindContextValue?.("self", celSelfView(getSelf()));
              for (const template of definition.resources ?? []) {
                childContext.registerManifest(
                  expandSelf(template, "", deferredPathsFor(template?.kind)),
                );
              }
              registered = true;
            }
            await childContext.initializeResources();
            return { result: undefined, inverse: () => childContext.teardownResources() };
          }),

        ...(invokeTarget && {
          invoke: async (inputs: any) => {
            const entry = dispatchEntry(invokeTarget, "invoke");
            if (!entry.instance?.invoke) {
              throw capabilityError(entry, invokeTarget, "invoke", "Telo.Invocable");
            }
            const invokeInputs =
              definition.inputs != null ? expand(definition.inputs, { self: celSelfView(getSelf()), inputs }) : inputs;
            const raw = await entry.instance.invoke(invokeInputs);
            if (definition.result == null) return raw;
            return expand(definition.result, { self: celSelfView(getSelf()), result: raw });
          },
        }),

        ...(runTarget && {
          run: async () => {
            const entry = dispatchEntry(runTarget, "run");
            if (!entry.instance?.run) {
              throw capabilityError(entry, runTarget, "run", "Telo.Runnable");
            }
            return entry.instance.run();
          },
        }),

        ...(provideTarget && {
          provide: async () => {
            const entry = dispatchEntry(provideTarget, "provide");
            if (!entry.instance?.invoke) {
              throw capabilityError(entry, provideTarget, "provide", "Telo.Invocable");
            }
            const provideInputs: any =
              definition.inputs != null ? expand(definition.inputs, { self: celSelfView(getSelf()) }) : {};
            const raw = await entry.instance.invoke(provideInputs);
            if (definition.result == null) return raw;
            return expand(definition.result, { self: celSelfView(getSelf()), result: raw });
          },
        }),

        ...(mountTarget && {
          // `register(app, prefix)` is the Telo.Mount contract a consuming
          // Http.Server calls. It is not on the base ResourceInstance type, so
          // the persistent mount child is accessed structurally.
          register: (app: any, prefix?: string) => {
            const entry = dispatchEntry(mountTarget, "mount");
            const mountable = entry.instance as { register?: (app: any, prefix?: string) => unknown };
            if (typeof mountable.register !== "function") {
              throw capabilityError(entry, mountTarget, "mount", "Telo.Mount");
            }
            return mountable.register(app, prefix);
          },
        }),

      };
    },
  };
}
