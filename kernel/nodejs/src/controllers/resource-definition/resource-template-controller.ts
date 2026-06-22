import type {
  CompiledValue,
  ControllerInstance,
  EvaluationContext,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";

/** CEL variables that are only bound at call time (request handling, step
 *  chaining, error branches) — never at a template's init(). A persistent
 *  child's body is expanded against `self` only, so a `${{ }}` node referencing
 *  any of these must survive untouched for the consuming controller (e.g. an
 *  Http.Api evaluating route CEL per request) to evaluate later. A node mixing
 *  `self` with a deferred variable in one expression is unsupported by design —
 *  keep `self`-derived literals and request-derived values in separate fields
 *  (e.g. a `self`-built SQL string vs. request-built `bindings`). */
const DEFERRED_VARS = new Set(["request", "result", "steps", "error"]);
const DEFERRED_RE = new RegExp(`(?<![.\\w])(?:${[...DEFERRED_VARS].join("|")})(?![\\w])`);

/** True when an expression reads a call-time-only variable. Prefers the AST-
 *  derived root identifiers stamped on the CompiledValue at compile time (exact —
 *  ignores string literals and substrings); falls back to a source-text scan for
 *  values produced by engines that surface no AST. */
function referencesDeferred(value: CompiledValue): boolean {
  if (value.refs) return value.refs.some((r) => DEFERRED_VARS.has(r));
  return typeof value.source === "string" && DEFERRED_RE.test(value.source);
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
    schema: definition.schema ?? { type: "object", additionalProperties: true },

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
      const targetName = (field: string | { kind?: string; name: string } | undefined): string | null => {
        if (field == null) return null;
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
      // to literals now; CEL bound only at call time (DEFERRED_VARS) passes
      // through compiled for the child's own controller. `!ref` sentinels are
      // rewritten to the `{kind, name, alias?}` injection shape here — Phase 2.5
      // (`resolveRefSentinels`) does not descend into template bodies, so the
      // child context's Phase 5 injection would otherwise see an unrecognized
      // sentinel and leave the slot unresolved. Kind is left empty: injection
      // dispatches by name and recovers the kind from the resolved instance.
      const expandSelf = (value: any): any => {
        if (isCompiledValue(value)) {
          if (referencesDeferred(value)) return value;
          // A pure `self.<path>` access (e.g. a `connection: !ref` passed down) is
          // resolved by navigating the resource directly. Going through CEL would
          // re-emit the value through CEL's output type-checker, which rejects live
          // resource instances (unrecognized class constructors) — so the connection
          // a consumer wired in could never reach a child's slot. Complex self
          // expressions (string building) still evaluate via CEL, where they yield
          // CEL-safe scalars.
          const path = typeof value.source === "string" ? value.source.trim().match(SELF_PATH) : null;
          if (path) {
            let cur: any = getSelf();
            for (const key of path[1].split(".").slice(1)) cur = cur?.[key];
            return cur;
          }
          return definingContext.expandWith(value, { self: getSelf() });
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
        if (Array.isArray(value)) return value.map(expandSelf);
        if (value !== null && typeof value === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value)) out[k] = expandSelf(v);
          return out;
        }
        return value;
      };

      // init() may run more than once: when a child's local ref names a sibling
      // not yet initialized, child init defers with ERR_LOCAL_REF_PENDING and the
      // outer multi-pass loop retries this resource. Registration must happen
      // once; each retry only resumes the child init loop (already-initialized
      // children are skipped, still-pending ones advance).
      let registered = false;

      return {
        init: async () => {
          if (!registered) {
            for (const template of definition.resources ?? []) {
              childContext.registerManifest(expandSelf(template));
            }
            registered = true;
          }
          await childContext.initializeResources();
        },

        ...(invokeTarget && {
          invoke: async (inputs: any) => {
            const entry = dispatchEntry(invokeTarget, "invoke");
            if (!entry.instance?.invoke) {
              throw capabilityError(entry, invokeTarget, "invoke", "Telo.Invocable");
            }
            const invokeInputs =
              definition.inputs != null ? expand(definition.inputs, { self: getSelf(), inputs }) : inputs;
            const raw = await entry.instance.invoke(invokeInputs);
            if (definition.result == null) return raw;
            return expand(definition.result, { self: getSelf(), result: raw });
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
              definition.inputs != null ? expand(definition.inputs, { self: getSelf() }) : {};
            const raw = await entry.instance.invoke(provideInputs);
            if (definition.result == null) return raw;
            return expand(definition.result, { self: getSelf(), result: raw });
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

        teardown: async () => {
          await childContext.teardownResources();
        },
      };
    },
  };
}
