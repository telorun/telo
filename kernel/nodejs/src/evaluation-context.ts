import { AsyncLocalStorage } from "node:async_hooks";
import { celHostScopeValue } from "./cel-host-scope-value.js";
import { formatSpanCounter } from "./logging/span-id.js";
import { settleNeedObservations } from "./need-observation.js";
import { parseTraceParent } from "./logging/trace-parent.js";
import { isTaggedSentinel } from "@telorun/templating";
import {
  deriveContext,
  getRefIdentity,
  InvokeError,
  isCelRecord,
  isCompiledValue,
  type CompiledValue,
  isInvokeError,
  isCancellationError,
  isSuspension,
  resourceKey,
  UNCANCELLABLE_CONTEXT,
  type EvaluationContext as IEvaluationContext,
  type SpanOutcome,
  type EmitEvent,
  type InstanceFactory,
  type InvokeContext,
  type LifecycleState,
  type OpenSpan,
  type OpenSpanOptions,
  type TraceCarrier,
  type PreInitHook,
  type ResourceDefinition,
  type ResourceInstance,
  type ResourceManifest,
  type ResourceOwner,
  type RuntimeDiagnostic,
  type ScopeContext,
  type ScopeHandle,
  type SpanSettleDetail,
  nowUnixNano,
} from "@telorun/sdk";
import { carryFailureFrames, errorTypeOf, membersEntryOfValue, moveFailureFrames, RuntimeError } from "@telorun/sdk";
import {
  celResourceReads,
  concreteEvalPaths,
  evalPathCovers,
  normalizeDeclaredScalars,
  reportsFromInit,
  startupObservedStateReads,
  type CelEvalSites,
  type EffectiveKind,
  type LoadedGraph,
} from "@telorun/analyzer";
import { authoredDeclarationOf, recordDeclarationScope } from "./declaration-scope.js";
import { boundInputOf, boundOutputOf } from "./invocation-contract-binding.js";
import {
  DETACHED_TASK_ENDED,
  DISPATCH_ENDED,
  holdDetachedInputs,
  holdersOf,
  holdLeavingRun,
  holdReturned,
  issuerHolds,
  issuingOwnerOf,
  RUNTIME_STOPPING,
  StreamOwner,
  streamOwnerOf,
} from "./held-streams.js";
import {
  attachErrorRedaction,
  bindInstanceRedaction,
  combinedScrub,
  errorRedactionOf,
  instanceRedactionOf,
  markScopeOpener,
  opensDispatchScope,
  redactionOfRun,
  RunRedaction,
  scopeRunIdentity,
  textsAtPaths,
} from "./scope-run-redaction.js";
import { outermostDeclarationOf } from "./instance-declaration.js";
import { recordDispatchExit } from "./failure-trace.js";
import { effectOwnerOf, executeReturnedChain } from "./effect-scope.js";
import { moduleCallsOf } from "./module-functions.js";
import { declarationReadsOf } from "./declaration-reads.js";
import {
  dispatchLocation,
  locateInvokeFailure,
  recordCallerDeclaration,
  type DispatchCaller,
} from "./failure-location.js";
import { impactClosure, reverseTopologicalOrder } from "./resource-edges.js";
import {
  mayReachListener,
  RESOURCE_CREATE_COMPLETED,
  RESOURCE_INITIALIZATION_COMPLETED,
  resourceTiming,
  startTiming,
} from "./resource-timing.js";
import {
  payloadViewOf,
  REDACTED,
  redactSensitive,
  sensitivePathsOfInstance,
} from "./instance-sensitive-paths.js";
import { spanAttributesOf } from "./instance-span-attributes.js";
import { censorSensitiveMembers, defineCensoredEntries } from "./sensitive-member-censor.js";
import { spanRecordOf, type FinishedSpan } from "./span-export.js";
import type { KernelTracer } from "./tracing.js";
import { settleDisplayMessage, type ErrorDataValidator } from "./declared-display-messages.js";
import {
  classifyInitFailures,
  isDeferral,
  renderInitFailureText,
  summarizeInitFailures,
  type FailedResource,
} from "./init-failure-diagnostics.js";
import {
  acceptReportedStatus,
  buildPublishedProps,
  diagnoseObservedStateAccess,
} from "./observed-state.js";
import { isResolvedReference } from "@telorun/analyzer";

export { resourceKey };

/** An edge in the resource dependency graph: a resolved `!ref` target. */
type ResourceRef = { kind: string; name: string; alias?: string };

/** What a `Telo.Import` declared as a scope member gives its scope run: the
 *  names it exports and each one's terminal getter, read once it has built. */
export interface ScopedImportScope {
  readonly names: ReadonlySet<string>;
  terminal(
    name: string,
  ): (() => { kind: string; instance: ResourceInstance; manifest?: ResourceManifest } | undefined) | undefined;
}

/** A resolved reference — the marked shape `resolveRefSentinels` produces
 *  (Phase 2.5). An inline definition (`{ kind, ...config }`) carries no marker
 *  and is its own node, so it is not an edge here; a live `ResourceInstance`
 *  (injected at Phase 5) carries none either. */
function isResolvedRef(value: unknown): value is ResourceRef {
  return isResolvedReference(value);
}

/** The system kinds whose top-level `schema:` is, by definition, a JSON Schema
 *  document (with `examples` / `default` / `const`) rather than config — a
 *  `{kind, name}` inside one is documentation data, not a `!ref`. For these the
 *  `schema` field is skipped when walking for refs/properties; for every other
 *  kind a `schema` field is ordinary config and is walked normally, so a real
 *  `schema: !ref X` still resolves. Narrowly scoped (rather than skipping any
 *  field named `schema` on every kind) so the heuristic can't misfire. */
const SCHEMA_AS_CONTRACT_KINDS = new Set(["Telo.Definition", "Telo.Abstract", "Telo.Type"]);

/** The CEL names a module context answers, never a call. */
const MODULE_GLOBAL_NAMES: ReadonlySet<string> = new Set(["variables", "secrets", "resources", "ports", "module"]);

/**
 * Walk a resource manifest's config and collect every resolved `{kind, name,
 * alias?}` reference it points at — the outbound edges for the dependency graph.
 * Called at create time, before Phase-5 injection swaps refs for live instances,
 * so the targets are still inspectable plain objects; only plain containers are
 * descended into. Deduped by alias+name. `metadata` is always skipped
 * (the resource's own identity); `schema` is skipped only for the system kinds
 * that carry a JSON-Schema contract there (see {@link SCHEMA_AS_CONTRACT_KINDS}).
 * Ref leaves are not descended into.
 */
function collectResourceRefs(resource: ResourceManifest): ResourceRef[] {
  const found = new Map<string, ResourceRef>();
  const skipSchema = SCHEMA_AS_CONTRACT_KINDS.has(resource.kind as string);
  // A re-created resource is rebuilt from the manifest as REGISTERED, but
  // Phase-5 injection mutated that object in place on the previous pass — so a
  // ref slot may already hold a live instance, whose object graph is cyclic.
  // The walk is a best-effort edge collection for failure attribution, so it
  // stops at anything it has already seen rather than recursing forever.
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (isResolvedRef(value)) {
      const key = `${value.alias ?? ""}::${value.name}`;
      if (!found.has(key)) found.set(key, { kind: value.kind, name: value.name, ...(value.alias ? { alias: value.alias } : {}) });
      return;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return;
      seen.add(value);
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      // A live instance — forwarded into a template child as `self.<ref>`, or
      // injected on a previous pass — is not config: its graph reaches most of
      // the kernel, and a `{kind, name}` inside it is some other resource's edge.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return;
      if (seen.has(value)) return;
      seen.add(value);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === "metadata" || (skipSchema && k === "schema")) continue;
        visit(v);
      }
    }
  };
  for (const [k, v] of Object.entries(resource as Record<string, unknown>)) {
    if (k === "kind" || k === "metadata" || (skipSchema && k === "schema")) continue;
    visit(v);
  }
  return [...found.values()];
}

/**
 * Project resource refs onto the names they depend on IN THIS CONTEXT. A local
 * ref is its own name; a cross-module `Alias.name` ref depends on the local
 * `Telo.Import` resource named by the alias, since that is the resource whose
 * failure would strand it. Used to attribute an init failure to its cause.
 */
function localDependencyNames(refs: ResourceRef[]): string[] {
  return refs.map((r) => (r.alias && r.alias !== "Self" ? r.alias : r.name));
}

/**
 * Build a resource's resolved properties for the debug stream — its config "after
 * templating", with `${{ }}` / `!cel` reduced to concrete values. The manifest is
 * already compile-evaluated by the time it is created, so this just makes the
 * remaining live forms wire-friendly:
 *  - a resolved `!ref` (`{kind, name, alias?}`) → its `{kind, name}` target;
 *  - a deferred runtime expression (a `CompiledValue` left for per-call eval, e.g.
 *    an Http.Api route reading `request`) → its tagged source text — there is no
 *    concrete value for it at the resource level;
 *  - a string carrying a known secret value → `[secret]` (substring-scrubbed), so
 *    a compile-time `${{ secrets.x }}` never lands in the stream verbatim.
 * `metadata` / `schema` are omitted (identity and JSON-Schema, not config).
 */
/** Substring-scrubbing a secret shorter than this risks redacting unrelated
 *  content (a short/common-word value matches everywhere), so below it only a
 *  whole-value match is redacted. */
const MIN_SUBSTRING_SCRUB_LEN = 5;

/** A live resource instance, as opposed to the raw config value a slot held
 *  before Phase-5 injection — the same duck-test the reference-resolving
 *  controllers use. */
const hasSnapshotMethod = (value: unknown): boolean =>
  !!value && typeof (value as { snapshot?: unknown }).snapshot === "function";

/** A scope run whose teardown waits for the streams leaving it. */
interface PendingRun {
  readonly runOwner: StreamOwner;
  readonly holderInstance: unknown;
  /** Settles once the run is torn down. */
  readonly done: Promise<void>;
  /** A teardown failure no logger could report, handed to whoever settles the run. */
  failure: unknown;
}

/**
 * A scope member's declaration as ONE run registers it: every plain container
 * copied, so Phase-5 injection — which writes the instance a reference names
 * into the declaration holding it — writes into this run's copy, never into
 * the declaration the next run registers. Compiled expressions, tagged values
 * and anything that is not a plain container are shared.
 */
function declarationForRun<T>(value: T): T {
  if (Array.isArray(value)) return value.map(declarationForRun) as T;
  if (!value || typeof value !== "object" || isCompiledValue(value) || isTaggedSentinel(value)) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string]!;
    if ("value" in descriptor) descriptor.value = declarationForRun(descriptor.value);
  }
  return Object.create(proto, descriptors) as T;
}

export function buildResolvedProperties(
  resource: ResourceManifest,
  secretValues: Set<string>,
  /** The set of the scope run the resource was created in: every occurrence of
   *  its values is redacted, at any length. */
  runRedaction?: RunRedaction,
): Record<string, unknown> {
  const skipSchema = SCHEMA_AS_CONTRACT_KINDS.has(resource.kind as string);
  const scrub = (s: string): string => {
    let out = runRedaction ? runRedaction.scrub(s) : s;
    for (const secret of secretValues) {
      if (!secret) continue;
      // Exact match is always a secret; substring-redact only longer values so a
      // short secret can't garble unrelated text it happens to appear in.
      if (out === secret) out = "[secret]";
      else if (secret.length >= MIN_SUBSTRING_SCRUB_LEN && out.includes(secret)) {
        out = out.split(secret).join("[secret]");
      }
    }
    return out;
  };
  const visit = (value: unknown): unknown => {
    if (isCompiledValue(value)) return writtenExpression(value) ?? "[expression]";
    if (isResolvedRef(value)) return { kind: value.kind, name: value.name };
    if (typeof value === "string") return scrub(value);
    // A value of a type with members: censored when it holds a sensitive one, its
    // text otherwise (logging §14).
    if (membersEntryOfValue(value)) {
      const written = censorSensitiveMembers(value, "[secret]");
      return typeof written === "string" ? scrub(written) : written;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      // A live instance injected into a ref slot (e.g. a template child whose
      // `connection` was resolved to the real connection): show its identity, not
      // its internals. Other class instances (streams, clients) get a marker.
      const id = getRefIdentity(value);
      if (id) return { kind: id.kind, name: id.name };
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        return `[${(value as { constructor?: { name?: string } }).constructor?.name ?? "Object"}]`;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = visit(v);
      return out;
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resource as Record<string, unknown>)) {
    if (k === "kind" || k === "metadata" || (skipSchema && k === "schema")) continue;
    out[k] = visit(v);
  }
  return out;
}

/**
 * Kernel-internal propagation of the current invocation tree's cancellation
 * scope. NEVER the controller-facing contract — controllers always receive the
 * token as the explicit `InvokeContext` argument. This store exists only so the
 * kernel's own `invoke`/`invokeResolved` can discover which token to forward
 * when a composing controller re-invokes without threading it by hand.
 */
const cancellationStore = new AsyncLocalStorage<InvokeContext>();

/**
 * Instances whose `run()` has been dispatched. Reporting observed state before
 * this is an error (see observed-state.ts).
 *
 * Keyed on the instance rather than on `(context, name)` because the context
 * that STARTS a resource is not always the one that OWNS it: an importer's
 * `targets:` can name a library's exported instance, and the library's own
 * `ctx.setStatus()` — publishing into the context where its name lives — has to
 * see that it started.
 */
const startedInstances = new WeakSet<object>();

/**
 * The last observed state each instance reported. Sticky: it stays until the
 * resource is torn down, so a dispatch that reports nothing leaves the previous
 * reading in place — a listener's bound address does not stop being true between
 * calls. Keyed by instance for the same reason as `startedInstances`, and
 * because a scope's per-run instances are distinct by construction, which is
 * what keeps two concurrent runs from observing each other's readings.
 */
const reportedStatus = new WeakMap<object, Record<string, unknown>>();

/**
 * Instances whose `run()` has RETURNED. A long-lived Service never appears here
 * — its `run()` stays pending for the process lifetime — which is exactly the
 * distinction the reader needs: a Runnable that finished and reported nothing
 * for a field it declares is a producer defect, while a Service that is still
 * coming up is ordering, and telling those apart is not something the reader
 * can do from the manifest.
 */
const completedInstances = new WeakSet<object>();

/**
 * The published value for an instance the caller resolved itself, rather than
 * one reached by name through a context's own `resourceInstances`. The
 * cross-module export path uses it: an importer surfaces a library's exported
 * instances under `resources.<Alias>.<name>`, which crosses the boundary
 * without passing through the owner's `resources` map — and must still carry the
 * reading the instance reported, under the same rules.
 *
 * `kind` is already canonical (`<module>.<Kind>`) on that path, so the resolver
 * needs no alias table.
 */
/**
 * The last published reading for an instance, by identity.
 *
 * CEL reads a resource through its PUBLISHED STATE — that is what
 * `resources.<name>.<field>` has always meant — and a resource reached through a
 * ref slot is no different: `self.table.table` and `resources.users.table` name
 * the same fact and must answer the same way. A ref slot holds the live
 * instance, which CEL cannot read a member off at all, so this is the table that
 * makes the two agree.
 *
 * Keyed by instance rather than by name because a ref slot carries no name, and
 * a `with:`-scoped resource has one published reading per scope run. Weak, so
 * nothing here extends an instance's lifetime, and deliberately one-directional
 * — an entry is a reading OF an instance, never a way to obtain one.
 */
const publishedByInstance = new WeakMap<object, Record<string, unknown>>();

/** The published reading for an instance, or undefined if it has never
 *  published — a resource that has not been created yet, or a foreign object. */
export function publishedPropsForInstance(
  instance: unknown,
): Record<string, unknown> | undefined {
  return instance && typeof instance === "object"
    ? publishedByInstance.get(instance as object)
    : undefined;
}

/**
 * The CEL-facing view of a template's `self`.
 *
 * Ref slots hold live instances after Phase-5 injection; each is replaced by its
 * published reading so a template body can read a scalar off a resource it
 * references. A slot whose instance has never published is left as it is — a
 * value CEL will reject on member access, which is the honest outcome rather
 * than an invented empty object that would make a typo evaluate to null.
 */
/**
 * A memoized `self` view, beside the exact readings it substituted.
 *
 * Invalidation is per view, checked against the reading each substituted
 * instance currently has — `publishedPropsOf` publishes a NEW props object every
 * time, so identity IS the version. A process-global counter was wrong twice
 * over: every `invoke()` republishes, so under any concurrency the memo was
 * defeated and the walk was back on the per-request path it was added for; and
 * the counter is shared across in-process kernels, so one app's traffic
 * invalidated another app's views.
 *
 * The check is O(substituted slots) — the refs, not the fields — and a view that
 * substituted nothing has an empty source list and is therefore always valid,
 * which is the common case.
 */
interface SelfView {
  readonly view: Record<string, unknown>;
  readonly sources: readonly [object, Record<string, unknown>][];
}

const selfViews = new WeakMap<object, SelfView>();

function viewIsCurrent(cached: SelfView): boolean {
  for (const [instance, props] of cached.sources) {
    if (publishedByInstance.get(instance) !== props) return false;
  }
  return true;
}

export function celSelfView(self: Record<string, unknown>): Record<string, unknown> {
  // A template's `invoke` expands its body on EVERY dispatch, so this sits on
  // the per-request path: without the memo a repository rebuilt the whole view
  // per call.
  const cached = selfViews.get(self);
  if (cached && viewIsCurrent(cached)) return cached.view;

  const sources: [object, Record<string, unknown>][] = [];
  let view: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(self)) {
    const substituted = celValueView(value, sources);
    if (substituted === value) continue;
    view ??= { ...self };
    view[key] = substituted;
  }
  const resolved = view ?? self;
  selfViews.set(self, { view: resolved, sources });
  return resolved;
}

/**
 * A ref slot holds one instance or a LIST of them (`tables: [!ref a, !ref b]`),
 * and both are ref slots — so converting only the first would make
 * `self.tables[0].name` mean something different from `self.table.name`, which
 * is the inconsistency this rule exists to remove.
 *
 * Arrays only: the walk stops at any other object, because a nested plain object
 * in a manifest is the author's own data and a resource's published reading is
 * not something to graft into the middle of it.
 */
function celValueView(
  value: unknown,
  sources: [object, Record<string, unknown>][],
): unknown {
  const published = publishedPropsForInstance(value);
  if (published) {
    sources.push([value as object, published]);
    return published;
  }
  if (!Array.isArray(value)) return value;
  let copy: unknown[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const substituted = celValueView(value[i], sources);
    if (substituted === value[i]) continue;
    copy ??= [...value];
    copy[i] = substituted;
  }
  return copy ?? value;
}

export async function publishedPropsOf(
  kind: string,
  name: string,
  instance: ResourceInstance,
  effectiveKind: ((kind: string) => EffectiveKind | undefined) | undefined,
): Promise<Record<string, unknown>> {
  const snap =
    typeof instance.snapshot === "function"
      ? ((await Promise.resolve(instance.snapshot())) as Record<string, unknown> | undefined)
      : undefined;
  const props = buildPublishedProps(snap, {
    kind,
    name,
    module: kind.split(".")[0],
    statusSchema: effectiveKind?.(kind)?.status,
    status: reportedStatus.get(instance),
    started: startedInstances.has(instance),
    completed: completedInstances.has(instance),
    reportsFromInit: reportsFromInit(effectiveKind?.(kind)?.capability),
  });
  publishedByInstance.set(instance, props);
  return props;
}

/**
 * The ambient dispatch context, for §7.2's automatic trace correlation: a record
 * emitted inside an active span carries that span's ids without the controller
 * passing anything.
 *
 * `AsyncLocalStorage.run()` is used throughout rather than `enterWith()`, which
 * transitions for the remainder of the entire synchronous execution and leaks
 * context into subsequent event handlers on the same tick (§9.1).
 */
export function ambientInvokeContext(): InvokeContext | undefined {
  return cancellationStore.getStore();
}

/**
 * Establish `ctx` as the ambient invocation context for the duration of `fn`.
 * The seam `withZone` uses to make an opened zone ambient without owning the
 * store — the store itself stays kernel-internal, never on the SDK surface.
 */
export function runWithAmbientContext<T>(ctx: InvokeContext, fn: () => T): T {
  return cancellationStore.run(ctx, fn);
}

/** A compiled value as its author wrote it — `!cel "x"`, `!interpolate "a ${{ x }}"`. */
function writtenExpression(value: CompiledValue): string | undefined {
  if (typeof value.source !== "string") return undefined;
  const engine = (value as { engine?: unknown }).engine;
  return `!${typeof engine === "string" ? engine : "cel"} ${JSON.stringify(value.source)}`;
}

/** Marks a scope built by {@link EvaluationContext.bindScope}, whose properties
 *  are getters. `expandWith` merges such a scope by descriptor rather than by
 *  value — reading the value here is what a lazy binding must not do. */
const LAZY_SCOPE = Symbol("telo.lazyScope");

type Walker = (ctx: Record<string, unknown>) => unknown;

/** Compile a manifest subtree into a tightly-bound walker closure. The returned
 *  function takes an activation object and rebuilds a fresh container of the
 *  same shape with all `${{ }}` CompiledValues evaluated against the activation.
 *  Per-call overhead is one closure invocation per node — no isCompiledValue /
 *  Array.isArray / typeof / Object.entries checks at runtime. */
function compileWalker(value: unknown): Walker {
  if (isCompiledValue(value)) {
    const compiled = value;
    return (ctx) => {
      try {
        return compiled.call(ctx);
      } catch (error) {
        const expr = writtenExpression(compiled) ?? "unknown expression";
        const msg = error instanceof Error ? error.message : String(error);
        // Reading observed state that was never reported is its own failure with
        // its own remedy, so it does not degrade into a bare "no such key".
        const observed = compiled.source
          ? describeObservedStateFailure(compiled.source, ctx, msg)
          : null;
        if (observed) {
          throw new RuntimeError("ERR_OBSERVED_STATE_UNAVAILABLE", `${expr}: ${observed}`);
        }
        // A CODED failure keeps its code, its data and its class: a module
        // function's `ERR_FUNCTION_FAILED` has to reach a `try:` / `catches:` as
        // the structured error it is, and a kernel refusal raised inside an
        // expression has to stay one. Only the message learns which expression.
        if (isInvokeError(error)) {
          throw new InvokeError(error.code, `Expression ${expr} failed: ${msg}`, error.data, {
            cause: error,
          });
        }
        if (error instanceof RuntimeError) {
          const coded = new RuntimeError(
            error.code,
            `Expression ${expr} failed: ${msg}`,
            error.diagnostics,
          );
          (coded as { cause?: unknown }).cause = error;
          throw coded;
        }
        const hint = compiled.source ? describeFailedAccess(compiled.source, ctx, msg) : null;
        const suffix = hint ? `\n  ${hint}` : "";
        throw new Error(`Expression ${expr} failed: ${msg}${suffix}`);
      }
    };
  }
  if (Array.isArray(value)) {
    const childWalkers = value.map(compileWalker);
    const n = childWalkers.length;
    return (ctx) => {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = childWalkers[i]!(ctx);
      return out;
    };
  }
  // Only PLAIN objects are rebuilt. Anything else — a `Uint8Array` embedded by
  // `!include-bytes`, a branded CEL value, a class instance — is opaque and passes
  // through by reference, the same rule `precompileDoc` follows. Rebuilding from
  // `Object.entries` would turn a byte buffer into `{"0":137,…}` silently, with
  // no error anywhere: the bytes would simply arrive at the controller as the
  // wrong shape. The question is asked of the value DOMAIN rather than of the
  // prototype, because a branded value (a decoded instant, a duration, a uint) is
  // a plain object and a rebuild drops the symbol its brand lives under — CEL then
  // reads a decoded instant as a `map` and no overload takes it.
  if (isCelRecord(value)) {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => [k, compileWalker(v)] as const,
    );
    const n = entries.length;
    return (ctx) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const [k, fn] = entries[i]!;
        out[k] = fn(ctx);
      }
      return out;
    };
  }
  return () => value;
}

/** A resource between its `create()` and its `init()`. */
interface CreatedInstance {
  resource: ResourceManifest;
  instance: ResourceInstance;
  ctx: any;
  source: ResourceManifest;
}

/**
 * Base class for all evaluation contexts. Owns template
 * expansion, secrets redaction, and the generic resource lifecycle tree.
 *
 * Every EvaluationContext node can:
 *   - Hold its own resource instances (resourceInstances)
 *   - Queue resources for initialization (pendingResources)
 *   - Spawn child contexts (spawnChild) forming a lifecycle tree
 *   - Run a multi-pass initialization loop (initializeResources)
 *   - Cascade teardown depth-first through the tree (teardownResources)
 */
export class EvaluationContext implements IEvaluationContext {
  readonly id = Math.random().toString(16).slice(2, 8);
  protected _context: Record<string, unknown>;
  protected _secretValues: Set<string>;
  protected _createInstance: InstanceFactory;
  readonly emit: EmitEvent;

  /** Position in the lifecycle tree. */
  parent: IEvaluationContext | undefined = undefined;
  readonly children: IEvaluationContext[] = [];

  /** Set on a scope run's child context: the run's own redaction set. */
  ownRunRedaction: RunRedaction | undefined = undefined;

  /** The redaction set of the scope run this context belongs to, at any depth
   *  beneath it, or undefined outside every run. */
  get runRedaction(): RunRedaction | undefined {
    return this.ownRunRedaction ?? (this.parent as EvaluationContext | undefined)?.runRedaction;
  }

  /** Where this node sits in its parent's teardown cascade — ascending, default
   *  0, reverse-registration within a tier. See `childTeardownOrder`. */
  teardownPriority: number | undefined = undefined;

  /** Current lifecycle state of this context node. */
  state: LifecycleState = "Pending";

  /** Resource instances owned by this context node, keyed by resourceKey(). */
  readonly resourceInstances = new Map<
    string,
    { resource: ResourceManifest; instance: ResourceInstance }
  >();

  /** Resources that have been created but not yet initialized (between phases).
   *  `source` is the manifest as REGISTERED, kept so a discarded instance is
   *  rebuilt from what the author wrote rather than from the create-time
   *  expansion of it. */
  protected readonly createdInstances = new Map<string, CreatedInstance>();

  /**
   * Resources whose failed `init()` could not be rolled back.
   *
   * Withheld rather than retried: re-running `init()` from a state an inverse
   * refused to restore is worse than not retrying, so the loop skips them and
   * they are reported with both the init error and the refusing inverse.
   */
  private readonly withheldResources = new Set<string>();

  /**
   * Keys whose instance was REMOVED BY AN UNWIND — the fact a dispatch that
   * misses actually needs, as opposed to the context-wide state that only
   * approximates it.
   *
   * A miss because the resource went away is the runtime withdrawing, not a
   * manifest defect, and the two want opposite follow-ups (see `invoke`). Both
   * paths that withdraw one go through `unwindEach`, the single removal site, so
   * recording it there covers a shutdown AND a reconciliation — where a check
   * against `state` would have converted the first and missed the second, since
   * `unwindResources` deliberately leaves the state untouched. The second is the
   * one that fires on every watch-session save.
   *
   * Cleared when the key is registered again: after a reconcile the name means a
   * live resource, and a stale entry would report a genuine missing-resource
   * defect as a cancellation.
   */
  private readonly unwoundResources = new Set<string>();

  /** Resources discarded after a failed `init()` and re-queued for creation.
   *  Their re-creation is not progress — see the create sub-phase. */
  private readonly recreatedResources = new Set<string>();

  /**
   * Instances this context can reach by name but does NOT own — a library's
   * declared `resources:` inputs, bound here by the import that handed them
   * down.
   *
   * **Borrowed, not owned.** The instance's effect frame belongs to the scope
   * that DECLARED it, so this context must never include it in its own
   * teardown: a library tearing one down would close the application's
   * connection out from under everything else still using it.
   */
  protected readonly borrowedResources = new Set<string>();

  /**
   * Bind an instance this context does not own under `name`, and mirror its
   * published reading into this context's `resources` scope so
   * `resources.<name>.<field>` reads here exactly as it does where the resource
   * is declared.
   *
   * The mirror is a subscription rather than a copy because a published value is
   * a READING: the owner republishes after `run()`, after every `invoke()` and
   * on every `setStatus()`, and a snapshot taken once at binding would go stale
   * at the first of those — silently, since nothing downstream can tell a stale
   * reading from a current one.
   */
  adoptBorrowedResource(
    name: string,
    resource: ResourceManifest,
    instance: ResourceInstance,
    owner: EvaluationContext,
  ): void | (() => void) {
    this.resourceInstances.set(name, { resource, instance });
    this.unwoundResources.delete(name);
    this.borrowedResources.add(name);
    this.declaredManifests.set(name, resource);
    const unmirror = owner.mirrorPublications(resource.metadata.name as string, (props) =>
      this.onResourceSnapshotted(name, props),
    );
    // The INVERSE, returned rather than performed: an import whose `init()`
    // fails is discarded and re-created on the next pass, so a subscription left
    // behind would be appended again on every pass — unbounded — and would keep
    // a dead child context reachable from the live owner. The binding is not on
    // this context's teardown path either (`teardownOrder` filters a borrowed
    // name out, and that is also the only place an entry is deleted), so
    // undoing it has to be stated here.
    return () => {
      unmirror();
      this.borrowedResources.delete(name);
      this.resourceInstances.delete(name);
      this.declaredManifests.delete(name);
    };
  }

  /** Publication mirrors registered by {@link adoptBorrowedResource}, by the
   *  OWNER's name for the resource. */
  private readonly publicationMirrors = new Map<
    string,
    Array<(props: Record<string, unknown>) => void>
  >();

  /** Register a mirror and replay the current reading, so a borrower that binds
   *  after the owner has already published does not wait for the next one.
   *  Returns the unsubscribe — a subscription with no way to end it outlives
   *  whatever registered it. */
  mirrorPublications(name: string, sink: (props: Record<string, unknown>) => void): () => void {
    const bucket = this.publicationMirrors.get(name);
    if (bucket) bucket.push(sink);
    else this.publicationMirrors.set(name, [sink]);
    const entry = this.resourceInstances.get(name) ?? this.createdInstances.get(name);
    const current = entry ? publishedByInstance.get(entry.instance) : undefined;
    if (current) sink(current);
    return () => {
      const sinks = this.publicationMirrors.get(name);
      if (!sinks) return;
      const at = sinks.indexOf(sink);
      if (at >= 0) sinks.splice(at, 1);
      if (sinks.length === 0) this.publicationMirrors.delete(name);
    };
  }

  /** Resources queued for initialization on this context node. */
  private pendingResources: ResourceManifest[] = [];

  /**
   * Every manifest ever registered on this node, by name — kept after the
   * resource has been created, unlike `pendingResources`, which drains.
   *
   * A DECLARATION-derived contract (`x-telo-schema-projection-from`) is resolved
   * when the kernel binds a contract, which happens during create — so the
   * pending queue has already given the target up by then. The declaration is
   * what the projection reads (a table's `columns:`), not the instance, so this
   * is the record it needs. Manifests only, one direction: nothing here yields
   * an instance, and nothing here extends one's lifetime.
   */
  protected readonly declaredManifests = new Map<string, ResourceManifest>();

  /** Per-resource dependency names, captured at create() time — BEFORE Phase-5
   *  injection swaps refs for live instances, so the walk sees plain objects and
   *  cannot wander into a controller's (possibly cyclic) object graph.
   *
   *  RETAINED for the context's lifetime: read to attribute an init failure to
   *  its cause, to order teardown (`teardownOrder`, without declaration reads)
   *  so a consumer's inverses run while the resources it holds are still alive,
   *  and to find what a reconciliation re-creates (`impactedBy`). */
  private readonly resourceDependencies = new Map<string, string[]>();

  /** The names among a resource's dependencies it reaches by more than a
   *  reference: a CEL read or a module call. A name it otherwise reaches only
   *  through a declaration-read site (`declaration-reads.ts`) orders nothing at
   *  teardown, since nothing of the target's instance is held. */
  private readonly readDependencies = new Map<string, ReadonlySet<string>>();

  /**
   * Names resolved by NAME during initialization, rather than through a
   * declared reference slot — so a resource somebody may be holding, with no
   * edge recording who.
   *
   * The set is of TARGETS, not of pairs: the door that records
   * (`ModuleContext.getInstance`) is reached as `ctx.moduleContext`, which every
   * resource of the module shares, so there is no caller to attribute the read
   * to. That is enough for the one decision that depends on it — see
   * {@link impactedBy}.
   */
  protected readonly opaquelyRead = new Set<string>();

  /** Record a by-name resolution. Called by the recording door only. */
  protected recordOpaqueRead(name: string): void {
    this.opaquelyRead.add(name);
  }

  /**
   * Optional hook called between create() and init() for each resource.
   * Set by the kernel to inject live instances into reference fields.
   */
  preInitHook?: PreInitHook;

  /**
   * Optional definition lookup used by invoke()/invokeResolved() to check
   * thrown InvokeError.code against the declared throw union (rule 9).
   * Set by the kernel; propagates through spawnChild() like preInitHook.
   */
  getDefinition?: (kind: string) => ResourceDefinition | undefined;

  /** What a registered kind means along `extends` — the analysis registry's
   *  answer. Set by the kernel beside `getDefinition`. */
  effectiveKind?: (kind: string) => EffectiveKind | undefined;

  /** Holds an error's data to the schema its kind declares for the code, where
   *  the error leaves a dispatch. Set by the kernel beside `getDefinition`. */
  errorDataValidator?: ErrorDataValidator;

  /** The load's graph, which a failure's frames are positioned against. Set by the
   *  kernel beside `getDefinition`; read on the failure path only. */
  failureGraph?: () => LoadedGraph | undefined;

  /**
   * Per-kernel invocation tracer. Set by the kernel on the root context and
   * propagated through spawnChild(); gates invocation-id minting in runInvoke()
   * and receives every finished span for the attached trace sinks.
   */
  tracer?: KernelTracer;

  /**
   * The resource that owns this context's resources — stamped by a template
   * controller on the child context it registers its `resources:` into.
   * Propagated through spawnChild() so scoped/nested children inherit it. Drives
   * the hierarchical `id` and `owner` every lifecycle/dispatch event carries, so
   * a debug consumer nests children under their parent and two instances of the
   * same templated kind don't collide by name. Undefined ⇒ top-level resources.
   */
  owner?: ResourceOwner;

  /** The holders of the scope run this context is, from its module's top level
   *  down; empty outside every scope run. A `Telo.Import` declared in the scope
   *  names its module instance beneath them. */
  scopeHolders: readonly string[] = [];

  /** The scope field (`with`) of the holder this scope run is, when known. */
  scopeField?: string;

  /** The `Telo.Import`s this scope run declares, by member name: instance names
   *  only, never a module alias. */
  private readonly scopedImports = new Map<string, ScopedImportScope>();

  /** Register what a scoped `Telo.Import` exports — the inverse removes it. */
  registerScopedImport(alias: string, scope: ScopedImportScope): () => void {
    this.scopedImports.set(alias, scope);
    return () => {
      if (this.scopedImports.get(alias) === scope) this.scopedImports.delete(alias);
    };
  }

  /** An instance a scoped `Telo.Import` of this scope run exports, or undefined
   *  when no such import declares `alias` here. */
  scopedImportInstance(alias: string, name: string): ResourceInstance | undefined {
    const scope = this.scopedImports.get(alias);
    if (!scope || !scope.names.has(name)) return undefined;
    return scope.terminal(name)?.()?.instance;
  }

  /** The manifest half of {@link scopedImportInstance}. */
  scopedImportManifest(alias: string, name: string): ResourceManifest | undefined {
    const scope = this.scopedImports.get(alias);
    if (!scope || !scope.names.has(name)) return undefined;
    return scope.terminal(name)?.()?.manifest;
  }

  /** Whether this scope run declares a `Telo.Import` named `alias`. */
  declaresScopedImport(alias: string): boolean {
    return this.scopedImports.has(alias);
  }

  /** Id prefix for a resource created in this context: `owner.id + "/"`, or ""
   *  at the top level. A resource's full id is `ownerPrefix + kind + "." + name`. */
  get ownerPrefix(): string {
    return this.owner ? `${this.owner.id}/` : "";
  }

  /** The full hierarchical id of a resource emitted from this context. */
  private resourceId(kind: string, name: string): string {
    return `${this.ownerPrefix}${kind}.${name}`;
  }

  /** Stamp each dependency ref with the target node's hierarchical id. A local
   *  (no-alias) sibling lives in this same context, so it carries this prefix; a
   *  cross-module (`alias`) target lives elsewhere, so it stays unqualified
   *  (best-effort — the renderer drops an edge that finds no node). */
  private qualifyDeps(refs: ResourceRef[]): (ResourceRef & { id: string })[] {
    return refs.map((ref) => ({
      ...ref,
      id: ref.alias ? `${ref.kind}.${ref.name}` : this.resourceId(ref.kind, ref.name),
    }));
  }

  constructor(
    readonly source: string,
    context: Record<string, unknown>,
    createInstance: InstanceFactory = async () => null,
    secretValues: Set<string>,
    emit: EmitEvent,
  ) {
    this._context = context;
    this._createInstance = createInstance;
    this._secretValues = secretValues ?? new Set();
    this.emit = emit;
  }

  get createInstance(): InstanceFactory {
    return this._createInstance;
  }

  /**
   * The name, in the module that makes the call, a qualified module call depends
   * on — or undefined when it depends on none. A module context answers; any
   * other context asks the module it belongs to, since the call resolves through
   * that module's names.
   */
  moduleCallHolder(qualified: string): string | undefined {
    return (this.parent as EvaluationContext | undefined)?.moduleCallHolder?.(qualified);
  }

  /** The dependency edges a manifest's module calls add: a function is held like
   *  any referenced resource, so rebuilding it rebuilds what calls it. */
  private moduleCallDependencies(resource: ResourceManifest): string[] {
    const names: string[] = [];
    for (const call of moduleCallsOf(resource)) {
      const holder = this.moduleCallHolder(call);
      if (holder !== undefined) names.push(holder);
    }
    return names;
  }

  /** Called once a resource has been removed by an unwind — the single removal
   *  site. Overridden by ModuleContext, whose function bindings hold instances. */
  protected onResourceWithdrawn(name: string, reason: string): void {
    void name;
    void reason;
  }

  /** Called after init() when a resource snapshot is available. Overridden by
   *  ModuleContext, and by a scope child (which keeps its own per-run map). */
  protected onResourceSnapshotted(name: string, snap: Record<string, unknown>): void {
    this.snapshotSink?.(name, snap);
  }

  /** Where published snapshots go for a context that has no `resources` map of
   *  its own — set by `createScopeHandle` on the per-run child so scope-local
   *  resources publish like any other. */
  protected snapshotSink: ((name: string, snap: Record<string, unknown>) => void) | undefined;

  /** Record that an instance has started. Republished so a read that arrives
   *  before the resource reports gets the "still running" message rather than
   *  the "never started" one. */
  private async markStarted(name: string, instance: ResourceInstance): Promise<void> {
    if (startedInstances.has(instance)) return;
    startedInstances.add(instance);
    await this.publishSnapshot(name);
  }

  /**
   * Record what a resource observed and republish. Validated against the kind's
   * `status:` here, at the point the claim is made, so an invalid report names
   * the call that made it rather than surfacing at some later publication.
   *
   * Replaces rather than merges: this is the resource's observed state now. A
   * declared field this call omits reads as missing, which is the truth — a
   * sometimes-absent field is declared nullable and reported as `null`.
   */
  async setResourceStatus(name: string, status: Record<string, unknown>): Promise<void> {
    const entry = this.resourceInstances.get(name) ?? this.createdInstances.get(name);
    if (!entry) return;
    const kind = entry.resource.kind as string;
    const fromInit = reportsFromInit(this.capabilityOf(kind));
    if (!fromInit && !startedInstances.has(entry.instance)) {
      throw new RuntimeError(
        "ERR_OBSERVED_STATE_BEFORE_START",
        `${kind} '${name}' reported observed state before it started. Only a Telo.Provider reports from init(); any other resource reports from run(), or from a handler it reaches.`,
      );
    }
    reportedStatus.set(
      entry.instance,
      acceptReportedStatus(status, { kind, name, statusSchema: this.statusSchemaOf(kind) }),
    );
    // A Provider still inside `init()` is published when `init()` returns — and
    // never, if it fails — so no reader sees a reading its init may yet undo.
    if (fromInit && this.resourceInstances.get(name)?.instance !== entry.instance) return;
    await this.publishSnapshot(name);
  }

  /**
   * Defer the creation of a resource whose startup (compile-eval) field reads
   * the observed state of a resource or import this context declares and has
   * not initialized yet. The read is an init-order edge, so the dependency
   * order normally initializes the producer first; this is the backstop for an
   * order the edge could not decide.
   */
  deferPendingStartupReads(label: string, resource: ResourceManifest, sites: CelEvalSites): void {
    for (const read of startupObservedStateReads(resource, sites)) {
      // A read through a family's index names the family: its members are the
      // producers, whichever key is read.
      const named = read.alias ?? read.name;
      const members = this.familyMembersOf?.(named) ?? [];
      for (const producer of members.length > 0 ? members : [named]) {
        if (!this.hasManifest(producer) || this.resourceInstances.has(producer)) continue;
        throw new RuntimeError(
          "ERR_LOCAL_REF_PENDING",
          `${label}: reads the observed state of '${producer}' at startup, and '${producer}' is registered but not initialized yet (deferring to a later init pass)`,
        );
      }
    }
  }

  /** What `kind`, spelled in this module's scope, means along `extends`. */
  private effectiveKindOf(kind: string): EffectiveKind | undefined {
    return this.effectiveKind?.(this.resolveKindSafe(kind)) ?? this.effectiveKind?.(kind);
  }

  /** The kind's effective `status:`, folded through `extends` in the scope that
   *  declared each definition. The same object until a registration, so the
   *  publication path's validator cache keyed on it compiles once. */
  private statusSchemaOf(kind: string): Record<string, any> | undefined {
    return this.effectiveKindOf(kind)?.status;
  }

  /**
   * The configured values a merge-form inheriting child publishes over the
   * parent instance's reading, or undefined when the kind declares none.
   *
   * Such a child is one instance created by its ancestor's controller, so `snapshot()` is the parent's and a field the parent never
   * declared would be readable from nowhere. The field NAMES are the kind's
   * `publishedOwnFields`, folded along the canonical `extends` the registry
   * records — never resolved in the READING module's scope, which may have no
   * alias for the parent's library. Done here rather than by rebinding the instance's
   * `snapshot()` because this is definition-derived data joined into a reading —
   * exactly what `statusSchemaOf` already does — and a second kernel cannot
   * rebind a trait method.
   *
   * Two values are withheld rather than published, both conservatively: a
   * runtime-eval field is still a `CompiledValue` at this point (only compile
   * paths are expanded at create), and a live instance is a collaborator rather
   * than a reading. Publishing either would put a wrong-typed value in the CEL
   * scope, which is the failure this overlay exists to remove.
   */
  private ownFieldOverlay(
    kind: string,
    resource: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const fields = this.effectiveKindOf(kind)?.publishedOwnFields;
    if (!fields?.length) return undefined;
    let overlay: Record<string, unknown> | undefined;
    for (const field of fields) {
      const value = resource[field];
      if (value === undefined || isCompiledValue(value) || hasSnapshotMethod(value)) continue;
      (overlay ??= {})[field] = value;
    }
    return overlay;
  }

  /**
   * Re-read a resource's `snapshot()` and republish it, joined with whatever
   * observed state the resource has reported. The single publication path — the
   * post-init capture, the post-run publication, the post-invoke refresh and
   * every `setStatus()` all land here.
   */
  async publishSnapshot(name: string): Promise<void> {
    const entry = this.resourceInstances.get(name) ?? this.createdInstances.get(name);
    if (!entry) return;
    const kind = entry.resource.kind as string;
    const own = this.ownFieldOverlay(kind, entry.resource);
    const statusSchema = this.statusSchemaOf(kind);
    // A kind declaring `status:` publishes with or without a `snapshot()`, so a
    // read of its observed state always reaches a reading that can say why.
    if (!entry.instance.snapshot && !own && !statusSchema) return;
    const snapshot = entry.instance.snapshot
      ? ((await Promise.resolve(entry.instance.snapshot())) as Record<string, unknown> | undefined)
      : undefined;
    const snap = own ? { ...(snapshot ?? {}), ...own } : snapshot;
    const props = buildPublishedProps(snap, {
      kind,
      name,
      module: entry.resource.metadata?.module as string | undefined,
      statusSchema,
      status: reportedStatus.get(entry.instance),
      started: startedInstances.has(entry.instance),
      completed: completedInstances.has(entry.instance),
      reportsFromInit: reportsFromInit(this.capabilityOf(kind)),
    });
    publishedByInstance.set(entry.instance, props);
    this.onResourceSnapshotted(name, props);
    for (const sink of this.publicationMirrors.get(name) ?? []) sink(props);
  }

  get context(): Record<string, unknown> {
    return this._context;
  }

  get secretValues(): Set<string> {
    return this._secretValues;
  }

  /**
   * Reorder pending resources to match the given name sequence (topo order from Phase 4).
   * Resources not present in `names` are left at the end in their original order.
   * Call before initializeResources() so the create/init sub-phases run in dependency order,
   * guaranteeing that Phase 5 injection always finds initialized dependencies.
   */
  setInitOrder(names: string[]): void {
    const rank = new Map(names.map((n, i) => [n, i]));
    this.pendingResources.sort((a, b) => {
      const ra = rank.get(a.metadata.name as string) ?? Infinity;
      const rb = rank.get(b.metadata.name as string) ?? Infinity;
      return ra - rb;
    });
  }

  /**
   * Queue a resource manifest for initialization on this context.
   */
  hasManifest(name: string): boolean {
    return (
      this.resourceInstances.has(name) ||
      this.createdInstances.has(name) ||
      this.pendingResources.some((r) => r.metadata.name === name)
    );
  }

  registerManifest(resource: ResourceManifest): void {
    if (!resource.metadata) {
      resource.metadata = { name: `Unnamed${Math.random().toString(16).slice(2, 8)}` };
    }
    const name = resource.metadata.name;
    if (this.hasManifest(name)) {
      throw new RuntimeError("ERR_DUPLICATE_RESOURCE", `Resource '${name}' is already registered`);
    }
    this.pendingResources.push(resource);
    this.declaredManifests.set(name, resource);
    recordDeclarationScope(resource, this);
  }

  /**
   * Forget a declaration entirely — the inverse of {@link registerManifest}.
   *
   * Reconciliation's other half: {@link unwindResources} disposes the INSTANCE,
   * and this clears everything keyed by the name so the same name can be
   * declared again. Without it `registerManifest` refuses with
   * `ERR_DUPLICATE_RESOURCE`, which is the right answer for a manifest
   * declaring one name twice and the wrong one for a second load of the same
   * manifest.
   *
   * Every per-name record goes, not just the declaration: a resource left in
   * `withheldResources` would be skipped by the init loop for the life of the
   * kernel, and a stale `createdInstances` entry would have the loop initialize
   * the object built from the PREVIOUS declaration.
   */
  deregisterManifest(name: string): void {
    this.declaredManifests.delete(name);
    this.resourceDependencies.delete(name);
    this.readDependencies.delete(name);
    this.createdInstances.delete(name);
    this.withheldResources.delete(name);
    this.recreatedResources.delete(name);
    this.opaquelyRead.delete(name);
    const pending = this.pendingResources.findIndex((r) => r.metadata?.name === name);
    if (pending >= 0) this.pendingResources.splice(pending, 1);
  }

  /**
   * The manifest a name was DECLARED with, resolved scope-local first and then
   * up the enclosing chain — the order `getInstance` and the CEL `resources`
   * layering already use, so a declaration lookup and an instance lookup agree
   * about what a name means inside a scope.
   *
   * `alias` routes into an import's exported instances, the one shape a bare
   * name cannot reach. Returns undefined rather than throwing: a caller here is
   * typing a contract, and a name that resolves to nothing is reported by the
   * check that owns that failure, not by a lookup.
   */
  resolveDeclaredManifest(name: string, alias?: string): ResourceManifest | undefined {
    if (alias && alias !== "Self") return this.resolveImportedManifest(alias, name);
    let node: EvaluationContext | undefined = this;
    while (node) {
      const found = node.declaredManifests.get(name);
      if (found) return found;
      node = node.parent as EvaluationContext | undefined;
    }
    return undefined;
  }

  /** Every name this context itself declares, with its declaration, in the
   *  order the declarations were registered — a borrowed resource input is the
   *  importer's declaration and is left out. */
  ownDeclarations(): Array<[string, ResourceManifest]> {
    return [...this.declaredManifests].filter(([name]) => !this.borrowedResources.has(name));
  }

  /** The manifest half of {@link resolveImportedInstance}. Overridden by
   *  `ModuleContext`, which is the only node that has imports. */
  resolveImportedManifest(alias: string, name: string): ResourceManifest | undefined {
    return undefined;
  }

  /**
   * Attach a child context to this node. The child's parent is set to this
   * context and the child is registered under the given name.
   */
  /**
   * Detach a child from this node — the inverse of {@link spawnChild}.
   *
   * A child is normally torn down in place, so this exists for the one case
   * that discards it instead: an import whose instance is dropped and rebuilt
   * must not leave its child in `children`, or this context's teardown cascades
   * into a context whose replacement is already live. Here rather than in the
   * controller, because how children are tracked is this class's own fact.
   */
  detachChild(child: IEvaluationContext): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }

  spawnChild<T extends IEvaluationContext>(child: T): T {
    child.parent = this;
    this.children.push(child);
    // Propagate injection hook so all child contexts (module imports, scopes) participate
    // in Phase 5 injection. createScopeHandle extends the lookup it resolves through.
    if (this.preInitHook && !child.preInitHook) {
      child.preInitHook = this.preInitHook;
    }
    if (this.getDefinition && !child.getDefinition) {
      child.getDefinition = this.getDefinition;
    }
    const inheriting = child as unknown as {
      effectiveKind?: (kind: string) => EffectiveKind | undefined;
      errorDataValidator?: ErrorDataValidator;
      failureGraph?: () => LoadedGraph | undefined;
    };
    if (this.effectiveKind && !inheriting.effectiveKind) {
      inheriting.effectiveKind = this.effectiveKind;
    }
    if (this.errorDataValidator && !inheriting.errorDataValidator) {
      inheriting.errorDataValidator = this.errorDataValidator;
    }
    if (this.failureGraph && !inheriting.failureGraph) {
      inheriting.failureGraph = this.failureGraph;
    }
    if (this.tracer && !child.tracer) {
      child.tracer = this.tracer;
    }
    // Inherit ownership so a scope/import opened inside a template's child
    // context keeps its resources nested under the same owner. A template
    // controller overrides this on its own child context after spawning.
    if (this.owner && !child.owner) {
      child.owner = this.owner;
    }
    return child;
  }

  /**
   * Bind a name into this context's own CEL scope.
   *
   * A copy is written rather than a mutation: `spawnChildContext` hands the
   * child the PARENT's context object by reference, so mutating it in place
   * would put the binding in the parent's scope as well.
   *
   * Used by a template to put `self` in scope for the body it creates, so a node
   * the nested kind evaluates later can read the enclosing resource's
   * configuration beside the call-time names that kind binds.
   */
  bindContextValue(name: string, value: unknown): void {
    // Descriptors, not values: a spread would read an accessor (the layered
    // `resources` of a template instance) once and keep that reading.
    const next = Object.defineProperties({}, Object.getOwnPropertyDescriptors(this._context));
    this._context = Object.assign(next, { [name]: value }) as Record<string, unknown>;
  }

  /** Remove a name from this context's own CEL scope, on a copy as
   *  {@link bindContextValue} writes one. */
  unbindContextValue(name: string): void {
    const descriptors = Object.getOwnPropertyDescriptors(this._context);
    delete descriptors[name];
    this._context = Object.defineProperties({}, descriptors) as Record<string, unknown>;
  }

  /** The members of a family of the layered body record, where there is one. */
  private familyMembersOf?: (family: string) => string[];

  /**
   * Make this context's CEL `resources` the record `layer` reads over `base`,
   * and publish what the context's own resources report into `layer`. Layering
   * happens at read time, as for a scope run, so a reading the enclosing module
   * republishes is seen on the next read.
   */
  layerResources(
    layer: {
      publish(name: string, reading: Record<string, unknown>): void;
      descriptor(base: () => unknown): PropertyDescriptor;
      membersOf(family: string): string[];
    },
    base: () => unknown,
  ): void {
    this.familyMembersOf = (family) => layer.membersOf(family);
    const next = Object.defineProperties({}, Object.getOwnPropertyDescriptors(this._context));
    Object.defineProperty(next, "resources", layer.descriptor(base));
    this._context = next as Record<string, unknown>;
    this.snapshotSink = (name, snap) => layer.publish(name, snap);
  }

  /** Spawn a fresh child context attached to this node — the isolated scope a
   *  templated definition registers its `resources:` into. Rooting it on the
   *  context that DEFINED the template (not the consumer that instantiated the
   *  kind) is what makes the template's internal kind aliases and `!ref`s
   *  resolve against the defining library's imports. Local sibling refs resolve
   *  in the child; a cross-module `!ref Alias.name` delegates to this context's
   *  imports (a plain child resolves none of its own). */
  spawnChildContext(): EvaluationContext {
    const child = new EvaluationContext(
      this.source,
      this.context,
      this._createInstance,
      this._secretValues,
      this.emit,
    );
    child.resolveImportedInstance = (alias, name) => this.resolveImportedInstance(alias, name);
    child.resolveImportedManifest = (alias, name) => this.resolveImportedManifest(alias, name);
    child.kindResolver = (kind) => this.resolveKindSafe(kind);
    child.declaredBeyondReach = (name) => !child.hasManifest(name) && this.declaresName(name);
    return this.spawnChild(child);
  }

  /**
   * Resolve a cross-module exported instance (`!ref Alias.name`) to its live instance.
   * Overridable hook: the base context has no imports, so it returns undefined; ModuleContext
   * overrides it to route into the named import's child context. Declared here so the
   * injection / scope closures in this base class can call it without downcasting.
   */
  resolveImportedInstance(alias: string, name: string): ResourceInstance | undefined {
    return undefined;
  }

  /**
   * The instance a reference written in this context names, as Phase-5
   * injection resolves it: through the import for an alias, among this
   * context's initialized resources otherwise. A scope child layers its
   * enclosing context in (`createScopeHandle`). Also what a native function's
   * data site is resolved through at creation, so the two cannot disagree.
   */
  injectionInstance(name: string, alias?: string): ResourceInstance | undefined {
    return alias && alias !== "Self"
      ? this.resolveImportedInstance(alias, name)
      : this.resourceInstances.get(name)?.instance;
  }

  /** True when `name` is declared here and not yet initialized — a reference to
   *  it defers rather than resolving to nothing. */
  injectionPending(name: string): boolean {
    return this.hasManifest(name) && !this.resourceInstances.has(name);
  }

  /** True when this context declares a resource named `name`. */
  declaresName(name: string): boolean {
    return this.hasManifest(name);
  }

  /** True when a bare `name` is one {@link injectionInstance} does not reach
   *  but the context this one was spawned from declares — a template body's
   *  reference to a resource of the module defining the template. Nothing for a
   *  context whose lookup reaches every name it can see. */
  declaredBeyondReach(name: string): boolean {
    return false;
  }

  /**
   * Interleaved create/init loop.
   *
   * Each pass has two sub-phases run back-to-back:
   *   1. Create sub-phase: call controller.create() for each pending resource that
   *      hasn't been created yet. Successful results go into createdInstances.
   *   2. Init sub-phase: call instance.init(ctx) for each created-but-not-inited
   *      resource. Successful results go into resourceInstances.
   *
   * Interleaving is necessary because some resources' create() depends on effects
   * produced by other resources' init() (e.g. Telo.Import.init() runs
   * child.initializeResources() which registers controllers needed by sibling
   * resources' create()). Running both sub-phases each pass lets those effects
   * propagate before the next create attempt.
   *
   * Each resource is created at most once and inited at most once.
   * ERR_VISIBILITY_DENIED and ERR_FATAL are re-thrown immediately.
   * All other errors are tracked and retried until no progress is made.
   */
  async initializeResources(): Promise<void> {
    const MAX_PASSES = 10;
    const errors = new Map<
      string,
      { message: string; code?: string; details?: string; children?: RuntimeDiagnostic[] }
    >();

    // The failure each entry of `errors` was built from, and the resource's frame
    // it gained: the trace the aggregate raised below carries.
    const rawErrors = new Map<string, unknown>();
    const failed = (name: string, error: unknown, declaration: ResourceManifest): void => {
      errors.set(name, formatErrorForDiagnostic(error));
      if (isDeferral(error)) return;
      rawErrors.set(name, error);
      recordDispatchExit(
        error,
        () => this.failureGraph?.(),
        () => ({
          kind: this.resolveKindSafe(declaration.kind as string),
          name,
          declaration: authoredDeclarationOf(declaration) ?? declaration,
        }),
        undefined,
        undefined,
      );
    };
    const cleared = (name: string): void => {
      errors.delete(name);
      rawErrors.delete(name);
    };

    const initialize = async (
      name: string,
      { resource, instance, ctx, source }: CreatedInstance,
    ): Promise<boolean> => {
      let progress = false;
      const initStartedAt = startTiming(this.emit, RESOURCE_INITIALIZATION_COMPLETED);
      let initOutcome: "initialized" | "deferred" | "failed" = "failed";
      try {
        if (this.preInitHook) {
          this.preInitHook(
            resource,
            (n, alias) => this.injectionInstance(n, alias),
            (n) => this.injectionPending(n),
            this,
          );
        }
        const scope = effectOwnerOf(instance)?.effects;
        scope?.openFrame("init");
        try {
          // What `init()` RETURNS is what undoes it. A controller that
          // allocates nothing returns nothing; there is no `teardown()`, so an
          // allocation outside the chain is one nothing will reclaim.
          if (instance.init) await executeReturnedChain(await instance.init(ctx), scope);
          // A Provider's startup ends here: every observing slot is reported.
          settleNeedObservations(instance, "init");
        } catch (error) {
          // What this attempt reported is discarded with it: a deferral re-runs
          // `init()`, a failure builds a fresh instance.
          reportedStatus.delete(instance);
          // Recover before the next pass: the loop retries a failed init, and
          // an init that registered a listener before it failed to connect
          // would otherwise register that listener again on every pass.
          //
          // HOW MUCH unwinds depends on whether the instance survives. A
          // deferral keeps it, so only the init frame goes — unwinding the
          // create frame there would destroy what construction built (a
          // connection's pool) and then re-init the same instance against it.
          // A real failure discards the instance, so everything `create()`
          // allocated on its behalf goes with it or nothing reclaims it.
          const deferred = isDeferral(error);
          const refused = (await (deferred ? scope?.unwindFrame() : scope?.unwindAll())) ?? [];
          if (refused.length > 0) {
            // Retrying from a state that could not be rolled back is worse
            // than not retrying, so the resource is withheld with a cause
            // naming both the init error and the inverse that refused. The
            // entry stays in `createdInstances` so it is still reported as a
            // failure; the loop skips it from here on.
            this.withheldResources.add(name);
            throw new RuntimeError(
              "ERR_EFFECT_RECOVERY_FAILED",
              `${resource.kind} '${name}' failed to initialize and could not be rolled back: ` +
                `${refused.map((f) => `'${f.reason}' (${errorText(f.error)})`).join(", ")}`,
              [
                { severity: "error", message: errorText(error), resource: name },
                ...refused.map((f) => ({
                  severity: "error" as const,
                  message: `inverse '${f.reason}' refused: ${errorText(f.error)}`,
                  resource: name,
                })),
              ],
            );
          }
          // A DEFERRAL is not a failure: it is the loop's own "your turn has
          // not come" signal, raised when a ref names a resource that has not
          // initialized yet. The instance stays — re-creating it would re-run
          // `create()`, which for an import re-registers its alias and reloads
          // its module, and for a template re-registers its children. Its init
          // frame alone was unwound above, so the next pass re-inits a
          // constructed resource rather than a dismantled one.
          if (deferred) throw error;
          // The inverses restored what init() touched OUTSIDE the instance;
          // the instance's own half-built fields are beyond their reach, so
          // the object goes too and the next pass builds a fresh one. That is
          // what makes "retry from a clean state" literal rather than a
          // convention each controller has to honour.
          this.createdInstances.delete(name);
          this.recreatedResources.add(name);
          // Re-queued as REGISTERED, not as created: the create-time manifest
          // has already been through compile-field expansion, and expanding
          // it a second time would evaluate an author's expression twice.
          this.pendingResources.push(source);
          throw error;
        }
        // Publish BEFORE registering: publication can fail (a kind returning
        // the reserved `status` key without declaring it, a report that does
        // not match `status:`), and a resource that failed must not be left
        // reachable through `getInstance` / Phase 5 injection / teardown.
        // `publishSnapshot` looks the instance up in `createdInstances` too,
        // so it resolves fine from here.
        await this.publishSnapshot(name);
        this.resourceInstances.set(name, { resource, instance });
        // Live again: a reconcile re-initializes what it unwound, and leaving
        // the mark would report a genuine missing-resource defect at this name
        // as a cancellation for the rest of the process.
        this.unwoundResources.delete(name);
        this.createdInstances.delete(name);
        cleared(name);
        progress = true;
        initOutcome = "initialized";
        await this.emit(`${resource.kind}.${resource.metadata.name}.Initialized`, {
          resource: {
            kind: resource.kind,
            name: resource.metadata.name,
            id: this.resourceId(resource.kind, resource.metadata.name),
          },
          ...(this.owner ? { owner: this.owner } : {}),
        });
      } catch (error) {
        if (isDeferral(error)) initOutcome = "deferred";
        if (error instanceof RuntimeError && (error.code === "ERR_VISIBILITY_DENIED" || error.code === "ERR_FATAL")) throw error;
        failed(name, error, source);
      }
      if (initStartedAt !== undefined) {
        await this.emit(
          RESOURCE_INITIALIZATION_COMPLETED,
          resourceTiming(resource, this.resourceId(resource.kind, name), initStartedAt, initOutcome),
        );
      }
      return progress;
    };

    let pass = 1;
    do {
      let progress = false;

      // Create sub-phase
      for (const resource of [...this.pendingResources]) {
        const name = resource.metadata.name;
        if (this.createdInstances.has(name)) continue;
        const createStartedAt = startTiming(this.emit, RESOURCE_CREATE_COMPLETED);
        let createOutcome: "created" | "skipped" | "failed" = "skipped";
        try {
          // const expanded = this.expand(resource) as ResourceManifest;
          // FIXME: Cannot expand it for all resources, needs to be selective
          const created = await this._createInstance(this, resource);
          if (created) {
            createOutcome = "created";
            const runRedaction = this.runRedaction;
            if (runRedaction) bindInstanceRedaction(created.instance as object, runRedaction);
            this.createdInstances.set(name, {
              resource: created.resource,
              instance: created.instance,
              ctx: created.ctx,
              source: resource,
            });
            const idx = this.pendingResources.findIndex((m) => m.metadata.name === name);
            if (idx >= 0) this.pendingResources.splice(idx, 1);
            cleared(name);
            // A FIRST creation is progress; RE-creating a resource whose init
            // failed is not. Counting it would keep the loop alive on a
            // permanently failing resource for every remaining pass, re-running
            // `create()` each time — ten module loads for a broken import, ten
            // pools for an unreachable database. Its retry still happens; what
            // it no longer does is claim the environment moved.
            if (!this.recreatedResources.has(name)) progress = true;
            const createdRes = created.resource;
            const refs = collectResourceRefs(createdRes);
            // `resource` rather than `createdRes`: the registered declaration
            // still holds its expressions, while the created copy holds the
            // values they were expanded to.
            const reads = new Set([...celResourceReads(resource), ...this.moduleCallDependencies(resource)]);
            this.resourceDependencies.set(name, [...new Set([...localDependencyNames(refs), ...reads])]);
            this.readDependencies.set(name, reads);
            const payload: Record<string, unknown> = {
              resource: {
                kind: createdRes.kind,
                name: createdRes.metadata.name,
                module: createdRes.metadata.module,
                id: this.resourceId(createdRes.kind, createdRes.metadata.name),
              },
              ...(this.owner ? { owner: this.owner } : {}),
              dependencies: this.qualifyDeps(refs),
            };
            // `properties` (the resolved config) is a second full config walk plus
            // a secret scrub. Build it lazily: the EventBus short-circuits when
            // nothing is subscribed (the no-debug-consumer case), so this getter
            // only runs when a consumer actually serializes the payload. Memoized
            // so multiple sinks (JSONL + SSE) don't rebuild it.
            let props: Record<string, unknown> | undefined;
            Object.defineProperty(payload, "properties", {
              enumerable: true,
              configurable: true,
              get: () =>
                (props ??= buildResolvedProperties(createdRes, this.secretValues, runRedaction)),
            });
            await this.emit(`${createdRes.kind}.${createdRes.metadata.name}.Created`, payload);
          }
        } catch (error) {
          createOutcome = "failed";
          if (error instanceof RuntimeError && (error.code === "ERR_VISIBILITY_DENIED" || error.code === "ERR_FATAL")) throw error;
          failed(name, error, resource);
        }
        if (createStartedAt !== undefined) {
          await this.emit(
            RESOURCE_CREATE_COMPLETED,
            resourceTiming(resource, this.resourceId(resource.kind, name), createStartedAt, createOutcome),
          );
        }
        // Initialized as soon as it is created: the pending list is in creation
        // order, so everything it depends on is already initialized, and a
        // resource after it whose `create()` needs it live finds it so on this
        // pass rather than the next.
        const created = createOutcome === "created" ? this.createdInstances.get(name) : undefined;
        if (created && (await initialize(name, created))) progress = true;
      }

      // Init sub-phase: what was created on an earlier pass, or created here
      // but deferred.
      for (const [name, entry] of [...this.createdInstances]) {
        if (this.resourceInstances.has(name) || this.withheldResources.has(name)) continue;
        if (await initialize(name, entry)) progress = true;
      }

      pass++;
      if (!progress) break;
    } while (pass <= MAX_PASSES);

    if (this.pendingResources.length > 0 || this.createdInstances.size > 0) {
      const toFailure = (name: string, kind: string, deps: string[]): FailedResource => {
        const info = errors.get(name) ?? { message: "Unknown error" };
        return {
          resource: name,
          kind,
          message: info.message,
          details: info.details,
          code: info.code,
          children: info.children,
          deps,
        };
      };
      const failures: FailedResource[] = [
        // A resource that never got created was never injected either, so its
        // manifest still carries plain `{kind, name}` refs — walk it here rather
        // than relying on the create-time capture it never reached.
        ...this.pendingResources.map((r) =>
          toFailure(r.metadata.name, r.kind, [
            ...localDependencyNames(collectResourceRefs(r)),
            ...this.moduleCallDependencies(r),
          ]),
        ),
        ...[...this.createdInstances].map(([name, { resource }]) =>
          toFailure(name, resource.kind, this.resourceDependencies.get(name) ?? []),
        ),
      ];
      const diagnostics = classifyInitFailures(failures);
      const aggregate = new RuntimeError(
        "ERR_RESOURCE_INITIALIZATION_FAILED",
        `${summarizeInitFailures(diagnostics)}:\n${renderInitFailureText(diagnostics)}`,
        diagnostics,
      );
      // The first root cause is what the aggregate wraps: it carries that failure's
      // trace and the failure itself becomes its cause.
      const root = diagnostics.find((d) => !d.derived && d.resource !== undefined && rawErrors.has(d.resource));
      if (root) {
        const cause = rawErrors.get(root.resource!);
        moveFailureFrames(cause, aggregate);
        (aggregate as { cause?: unknown }).cause = cause;
      }
      throw aggregate;
    }

    this.state = "Initialized";
  }

  withManifests<T>(manifests: any[], fn: () => T): T {
    const child = this.spawnChild(
      new EvaluationContext(
        this.source,
        this._context,
        this._createInstance,
        this._secretValues,
        this.emit,
      ),
    );
    try {
      for (const manifest of manifests) {
        child.registerManifest(manifest);
      }
      return fn();
    } finally {
      // Tear down child context and its resources immediately after fn() completes.
      // Note that this does NOT emit Kernel-level events (e.g. Teardown events) —
      // they remain the Kernel's responsibility.
      child.teardownResources();
    }
  }

  /** Scope runs opened in this context whose teardown waits for held streams. */
  readonly pendingRuns = new Map<EvaluationContext, PendingRun>();

  /** Tear `child` down once `runOwner` closes and every run opened inside it has
   *  been torn down — in the background, a failure reported on the holder's log,
   *  or, with no holder logger, handed to whoever settles the run. */
  deferRunTeardown(
    child: EvaluationContext,
    runOwner: StreamOwner,
    holderOwner: StreamOwner | undefined,
    holderInstance: unknown,
    redaction: RunRedaction | undefined,
  ): void {
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const pending: PendingRun = { runOwner, holderInstance, done, failure: undefined };
    this.pendingRuns.set(child, pending);
    runOwner.onClose(() => {
      holderOwner?.openRuns?.delete(runOwner);
      void (async () => {
        try {
          const unreported = await child.settlePendingRuns(false);
          await child.teardownResources();
          child.raiseTeardownFailures(unreported);
        } catch (err) {
          if (redaction) attachErrorRedaction(err, redaction);
          const log = (holderInstance ? effectOwnerOf(holderInstance as ResourceInstance) : undefined)?.log;
          if (log) log.error("Scope teardown failed", undefined, { error: err, eventName: "scope.teardown.failed" });
          else pending.failure = err;
        } finally {
          this.pendingRuns.delete(child);
          this.forgetChild(child);
          settled();
        }
      })();
    });
  }

  /**
   * Wait for every pending run opened in this context to be torn down. With
   * `cancel`, a shutdown: each run's held streams are cancelled first, so a later
   * pull raises `ERR_INVOKE_CANCELLED` rather than meet a torn-down resource.
   * Never rejects: a teardown failure with no logger to report it on is
   * returned, for the caller to aggregate with its own.
   */
  async settlePendingRuns(
    cancel: boolean,
    holderInstance?: unknown,
  ): Promise<Array<{ resource: string; error: unknown }>> {
    const runs = [...this.pendingRuns.values()].filter(
      (pending) => holderInstance === undefined || pending.holderInstance === holderInstance,
    );
    if (cancel) {
      for (const { runOwner } of runs) {
        for (const held of runOwner.leavingStreams()) held.cancel(RUNTIME_STOPPING);
        runOwner.close();
      }
    }
    await Promise.all(runs.map((pending) => pending.done));
    return runs
      .filter((pending) => pending.failure !== undefined)
      .map((pending) => ({ resource: "(scope run teardown)", error: pending.failure }));
  }

  forgetChild(child: IEvaluationContext): void {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
  }

  /**
   * Returns a ScopeHandle that initializes `manifests` in a fresh child context each time
   * `run()` is called, executes the callback with a ScopeContext, and tears down when done.
   *
   * The child inherits the parent's preInitHook (if any), extended so that `getInstance`
   * also checks the parent's already-initialized singleton instances. This lets scoped
   * resources hold x-telo-ref slots pointing to outer resources — those deps are already
   * live when the scope opens.
   */
  createScopeHandle(
    manifests: ResourceManifest[],
    holder?: ResourceManifest,
    field?: string,
    openedByDispatch = false,
  ): ScopeHandle {
    const parent = this;
    const holderLabel = (): string =>
      `${holder ? parent.resolveKindSafe(holder.kind as string) : "<unknown kind>"} '${String(holder?.metadata?.name ?? "<unnamed>")}'`;
    // An open names its inputs as the kind declares: an object on a scope
    // opened by dispatch, `null` on any other. A legacy one-argument open (a
    // controller published before the argument existed) reads as `null`.
    const openingOf = (args: unknown[]): { inputs: Record<string, unknown> | null; fn: (scope: ScopeContext) => Promise<unknown> } => {
      const legacy = typeof args[0] === "function" && args[1] === undefined;
      const [first, second] = legacy ? [null, args[0]] : args;
      if (first !== null && (typeof first !== "object" || Array.isArray(first))) {
        throw new RuntimeError(
          "ERR_SCOPE_OPENING_INVALID",
          `${holderLabel()} opened its \`${field ?? "scope"}\` scope with inputs that are not an object; ` +
            `the controller passes its invocation's inputs as an object, or null for a scope not opened by dispatch.`,
        );
      }
      if (openedByDispatch && first === null) {
        throw new RuntimeError(
          "ERR_SCOPE_OPENING_INVALID",
          `${holderLabel()} opened its \`${field ?? "scope"}\` scope without inputs, but the kind declares it ` +
            `\`openedBy: dispatch\`: the controller must pass the inputs of the invocation opening it, ` +
            `which its members' creation-time fields read as \`inputs\`. Upgrade the module providing the kind.`,
        );
      }
      if (!openedByDispatch && first !== null) {
        throw new RuntimeError(
          "ERR_SCOPE_OPENING_INVALID",
          `${holderLabel()} opened its \`${field ?? "scope"}\` scope with inputs, but the kind does not declare ` +
            `it \`openedBy: dispatch\`, so nothing reads them: the controller must pass null, or the kind ` +
            `declare \`x-telo-scope: { regions, openedBy: dispatch }\`.`,
        );
      }
      return { inputs: first as Record<string, unknown> | null, fn: second as (scope: ScopeContext) => Promise<unknown> };
    };
    // The resource owning the scope, as the issuer of its `targets:` runs.
    const holderCaller = (): DispatchCaller | undefined => {
      const holderName = holder?.metadata?.name;
      if (!holder || typeof holderName !== "string") return undefined;
      const declaration = authoredDeclarationOf(holder) ?? holder;
      const module = holder.metadata?.source ?? parent.source;
      return {
        kind: parent.resolveKindSafe(holder.kind as string),
        name: holderName,
        ...(typeof module === "string" ? { module } : {}),
        declaration,
      };
    };
    return {
      async run<T>(...args: unknown[]): Promise<T> {
        const { inputs, fn } = openingOf(args) as {
          inputs: Record<string, unknown> | null;
          fn: (scope: ScopeContext) => Promise<T>;
        };
        const holderName = holder?.metadata?.name;
        // The holder's own instance: its bound input contract is what the
        // opening inputs are typed and marked by.
        const holderInstance =
          typeof holderName === "string"
            ? (parent.resourceInstances.get(holderName) ?? parent.createdInstances.get(holderName))?.instance
            : undefined;
        const holderInput = boundInputOf(holderInstance);
        // A run with no sensitive value of its own redacts as its enclosing run
        // does, and a run under none with none costs no walk anywhere.
        const sensitive = inputs && holderInput ? textsAtPaths(inputs, holderInput.sensitivePaths()) : [];
        const redaction = sensitive.length > 0 ? new RunRedaction(sensitive, parent.runRedaction) : parent.runRedaction;
        if (holderInstance && sensitive.length > 0) markScopeOpener(holderInstance);
        const child = parent.spawnChild(
          new EvaluationContext(
            parent.source,
            parent._context,
            parent._createInstance,
            parent._secretValues,
            parent.emit,
          ),
        );
        child.kindResolver = (kind) => parent.resolveKindSafe(kind);
        child.scopeHolders = typeof holderName === "string" ? [...parent.scopeHolders, holderName] : parent.scopeHolders;
        child.scopeField = field;
        child.ownRunRedaction = redaction;
        const runIdentity = redaction ? scopeRunIdentity(redaction) : Object.freeze({});
        // The members' creation-time fields read the opening inputs as the
        // holder's step body does — declared scalars in their CEL form. A scope
        // not opened by dispatch reads none, an enclosing one's included.
        if (inputs) {
          child.bindContextValue(
            "inputs",
            holderInput ? normalizeDeclaredScalars(inputs, holderInput.scalarPaths()) : inputs,
          );
        } else if ("inputs" in parent._context) {
          child.unbindContextValue("inputs");
        }
        // A `Telo.Import` this run declares gives its exports to the run's
        // members and regions, innermost scope first, then the enclosing one's.
        child.resolveImportedInstance = (alias, name) =>
          child.declaresScopedImport(alias)
            ? child.scopedImportInstance(alias, name)
            : parent.resolveImportedInstance(alias, name);
        child.resolveImportedManifest = (alias, name) =>
          child.declaresScopedImport(alias)
            ? child.scopedImportManifest(alias, name)
            : parent.resolveImportedManifest(alias, name);

        // Per-run map of the scope's OWN resources. Fresh per run, so two
        // concurrent runs of the same sequence never observe each other's.
        // The enclosing module's map is layered in at read time, not copied
        // here: `setResource` replaces `_resources` wholesale on every publish,
        // so a snapshot taken at scope entry would go stale the moment an outer
        // resource republished (a post-invoke refresh, a later boot target).
        const scopeLocal = new Map<string, Record<string, unknown>>();
        child.snapshotSink = (name, snap) => {
          scopeLocal.set(name, snap);
        };

        // Extend the lookup injection resolves through to the enclosing context's,
        // at any depth of nested scopes. Only a scope-local dependency can still be
        // pending — an outer resource is live by the time a scope opens — so the
        // child's own pending predicate suffices.
        child.injectionInstance = (name, alias) => {
          if (alias && alias !== "Self") {
            return child.declaresScopedImport(alias)
              ? child.scopedImportInstance(alias, name)
              : parent.injectionInstance(name, alias);
          }
          const scoped = child.resourceInstances.get(name)?.instance;
          if (scoped) return scoped;
          // A name the scope DECLARES resolves to the scope's instance and to
          // nothing else. Falling through to the enclosing module while the
          // scoped one is merely not initialized yet would inject the resource
          // it shadows — an init-order-dependent wrong answer, and a silent
          // one: the ref binds an instance that is never started, so the
          // failure surfaces later as a timeout somewhere else entirely.
          // Returning nothing leaves it pending, which is what makes the init
          // loop come back to it.
          if (child.hasManifest(name)) return undefined;
          return parent.injectionInstance(name);
        };
        child.declaredBeyondReach = (name) =>
          !child.hasManifest(name) && parent.declaredBeyondReach(name);

        // The run is an owner of its own: produced when `fn` returns, open while a
        // stream leaving it is live. It is open on the dispatch that opened it, so
        // detached work that dispatch issues holds it too.
        const holderOwner = streamOwnerOf(cancellationStore.getStore());
        const runOwner = new StreamOwner(undefined, RUNTIME_STOPPING, undefined, holderLabel());
        (holderOwner ? (holderOwner.openRuns ??= new Set()) : undefined)?.add(runOwner);
        let deferred = false;
        try {
          for (const manifest of manifests) {
            child.registerManifest(declarationForRun(manifest));
          }
          await child.initializeResources();
          const scope: ScopeContext = {
            getInstance(name: string, alias?: string): ResourceInstance {
              // Cross-module exported instance (`!ref Alias.name` inside the scope) —
              // route into the owning import's child context, not scope-local resources.
              if (alias && alias !== "Self") {
                const imported = child.resolveImportedInstance(alias, name);
                if (imported) return imported;
                throw new RuntimeError(
                  "ERR_SCOPE_RESOURCE_NOT_FOUND",
                  `Cross-module reference '${alias}.${name}' did not resolve to an exported instance.`,
                );
              }
              const childEntry = child.resourceInstances.get(name);
              if (childEntry) return childEntry.instance;
              const parentEntry = parent.resourceInstances.get(name);
              if (parentEntry) return parentEntry.instance;
              throw new RuntimeError(
                "ERR_SCOPE_RESOURCE_NOT_FOUND",
                `Resource '${name}' not found in scope or outer context. Available scoped: ${[...child.resourceInstances.keys()].join(", ")}`,
              );
            },
            async run(name: string, options?: { calledAt?: string }): Promise<void> {
              // Through the child context's chokepoint, so a scope target is
              // traced, records that it started, and publishes its snapshot —
              // exactly like a boot target. A scope target is always a
              // with-resource, so it lives in the child.
              await child.run(name, undefined, holderCaller(), options?.calledAt);
            },
            get resources(): Record<string, unknown> {
              // Merged on read so the outer half stays live; scope-local names
              // win, matching `getInstance`'s order so CEL and `!ref` agree.
              const merged: Record<string, unknown> = {
                ...((parent._context.resources as Record<string, unknown> | undefined) ?? {}),
              };
              for (const [name, snap] of scopeLocal) merged[name] = snap;
              return merged;
            },
            runIdentity,
          };
          const produced = holdLeavingRun(await fn(scope), runOwner, holderOwner);
          runOwner.produce();
          if (runOwner.closed && child.pendingRuns.size === 0) return produced as T;
          // A stream leaves the run, or a run opened inside it is still held:
          // the value is handed on now and the run torn down once those settle.
          deferred = true;
          parent.deferRunTeardown(child, runOwner, holderOwner, holderInstance, redaction);
          return produced as T;
        } catch (error) {
          // A failure leaving the run carries its set to wherever its error value
          // is built — a transport's error log record, the holder's trace payload.
          if (redaction) attachErrorRedaction(error, redaction);
          // A run opened inside this one may still be held by a stream the
          // failing holder's dispatch owns: waiting for it here would wait for
          // the failure this throw delivers.
          // Detached work still pulling a stream leaving this run is cancelled,
          // so a later pull raises ERR_INVOKE_CANCELLED rather than meeting the
          // torn-down resources.
          for (const held of runOwner.leavingStreams()) held.cancel(RUNTIME_STOPPING);
          runOwner.close();
          if (child.pendingRuns.size > 0) {
            deferred = true;
            parent.deferRunTeardown(child, runOwner, holderOwner, holderInstance, redaction);
          }
          throw error;
        } finally {
          if (!deferred) {
            runOwner.close();
            holderOwner?.openRuns?.delete(runOwner);
            try {
              const unreported = await child.settlePendingRuns(false);
              await child.teardownResources();
              child.raiseTeardownFailures(unreported);
            } finally {
              parent.forgetChild(child);
            }
          }
        }
      },
    };
  }

  /**
   * Cascade teardown through the tree:
   *   1. Tear down own resource instances in {@link teardownOrder}, emitting a
   *      Teardown event for each via the injected emit callback.
   *   2. Sweep any child context still standing, in {@link childTeardownOrder}.
   *
   * **Own resources go FIRST, and the child sweep is a backstop.** A child
   * context that belongs to a resource is torn down by that resource's own
   * inverse — an import's `init()` returns `child.teardownResources()`, and so
   * does a template's — so it already unwinds at its owner's position in step 1,
   * which is the position the edges put it at. Running a child cascade ahead of
   * step 1 tore every imported library down before any resource of THIS context,
   * so an app resource holding `!ref Alias.name` unwound after its provider was
   * already gone, and the owner's inverse then found nothing left to do.
   *
   * Sweeping afterwards rather than not at all is what still reclaims a context
   * no inverse claims: a `lifecycle: shared` library, which is spawned under the
   * root and deliberately gives no importer a claim on it, and an import whose
   * `init()` never ran to register one. `teardownResources` is idempotent, so a
   * context already taken down in step 1 costs the sweep nothing.
   */
  // eslint-disable-next-line @typescript-eslint/member-ordering
  async teardownResources(): Promise<void> {
    this.state = "Draining";
    const failures = await this.settlePendingRuns(true);
    failures.push(...(await this.unwindEach(this.teardownOrder())));

    // The backstop: whatever no resource's inverse claimed. Everything an import
    // or a template owns is already down, so this is a no-op for it.
    for (const child of this.childTeardownOrder()) {
      try {
        await child.teardownResources();
      } catch (err) {
        failures.push({ resource: "(child context)", error: err });
      }
    }

    this.state = "Teardown";
    this.raiseTeardownFailures(failures);
  }

  /**
   * Unwind SOME of this context's resources and leave the rest running.
   *
   * The reconciliation half of teardown: a host that has decided which
   * declarations moved unwinds exactly {@link impactedBy}'s answer, then
   * re-registers and re-initializes. Ordering is {@link teardownOrder}
   * restricted to the selection, so a consumer still unwinds before what it
   * holds — and the selection being closed under holders is what makes that
   * true of the resources left standing as well, since none of them holds
   * anything in it.
   *
   * The context keeps its state: it is neither draining nor torn down, and no
   * child context is swept, because a child belonging to an unwound import goes
   * down with that import's own inverse exactly as it does at teardown.
   *
   * A name with no live instance is skipped rather than reported — a resource
   * that failed to initialize has nothing to unwind, and a host asking for it is
   * asking about a declaration, not about an instance.
   */
  // eslint-disable-next-line @typescript-eslint/member-ordering
  async unwindResources(names: ReadonlySet<string>): Promise<void> {
    const selected = this.teardownOrder().filter(([, entry]) =>
      names.has(entry.resource.metadata.name as string),
    );
    this.raiseTeardownFailures(await this.unwindEach(selected));
  }

  raiseTeardownFailures(failures: Array<{ resource: string; error: unknown }>): void {
    if (failures.length === 0) return;
    throw new RuntimeError(
      "ERR_TEARDOWN_FAILED",
      `${failures.length} resource(s) failed during teardown`,
      failures.map(({ resource, error }) => ({
        severity: "error" as const,
        message: error instanceof Error ? error.message : String(error),
        resource,
      })),
    );
  }

  /** Unwind the given entries in the order supplied, aggregating what refused.
   *  Failures are returned rather than thrown so one refusing inverse cannot
   *  strand the resources after it — the log sinks above all. */
  private async unwindEach(
    entries: Array<readonly [string, { resource: any; instance: any }]>,
  ): Promise<Array<{ resource: string; error: unknown }>> {
    const failures: Array<{ resource: string; error: unknown }> = [];

    for (const [key, { resource, instance }] of entries) {
      const label = `${resource.kind}.${resource.metadata.name}`;
      // A reading belongs to the run that produced it. The WeakMap would drop it
      // with the instance anyway; clearing here also covers an instance something
      // else still holds, so a torn-down resource can never keep publishing what
      // it observed in a previous life.
      reportedStatus.delete(instance);
      startedInstances.delete(instance);
      completedInstances.delete(instance);
      // Tearing a resource down IS unwinding its effects — every frame, newest
      // first, LIFO within each. There is no `teardown()` to call: what undoes a
      // resource is what its `init()` and `run()` returned.
      // Runs this resource opened and left held go first, their streams cancelled.
      failures.push(...(await this.settlePendingRuns(true, instance)));
      const owner = effectOwnerOf(instance);
      const refused = (await owner?.effects.unwindAll()) ?? [];
      if (refused.length > 0) {
        // Aggregate and continue: one refusing inverse must not strand the log
        // sinks pinned last to outlive everything that might log on the way
        // down.
        failures.push({
          resource: label,
          error: new RuntimeError(
            "ERR_EFFECT_RECOVERY_FAILED",
            `${refused.length} inverse(s) refused: ` +
              refused.map((f) => `'${f.reason}' (${errorText(f.error)})`).join(", "),
          ),
        });
      }
      // A drain waits for in-flight background work under a bound and then
      // abandons it — not an inverse, so it is not on a frame; it runs here,
      // once the resource's own effects are undone.
      try {
        await owner?.drainDetached();
      } catch (err) {
        // Aggregate rather than abort. A single throwing resource used to
        // abandon every resource after it in the cascade — including the log
        // sinks, which are pinned last precisely so they outlive everything that
        // might log while shutting down. Losing the shutdown flush to an
        // unrelated failure is exactly the silent loss §10.5 forbids.
        failures.push({ resource: label, error: err });
      }
      try {
        await this.emit(`${label}.Teardown`, {
          resource: {
            kind: resource.kind,
            name: resource.metadata.name,
            id: this.resourceId(resource.kind, resource.metadata.name),
          },
          ...(this.owner ? { owner: this.owner } : {}),
        });
      } catch (err) {
        failures.push({ resource: `${label} (Teardown event)`, error: err });
      }
      this.resourceInstances.delete(key);
      // The single removal site, so it is also where "this went away because the
      // runtime withdrew it" is recorded — the fact `invoke` reports a miss by.
      this.unwoundResources.add(key);
      this.onResourceWithdrawn(
        key,
        this.state === "Draining" || this.state === "Teardown"
          ? "the runtime is shutting down"
          : "its resource was unwound while the runtime reconciled",
      );
      // A torn-down resource must stop being readable: a CEL expansion that still
      // found its reading would bake a value nothing is serving any more.
      this.clearPublishedReading(resource.metadata.name as string);
    }

    return failures;
  }

  /**
   * Child contexts for the backstop sweep: ascending `teardownPriority`
   * (default 0), reverse registration within a tier.
   *
   * What reaches the sweep is a context no resource's inverse claimed, which in
   * practice is the `lifecycle: shared` libraries. Those are spawned under the
   * ROOT and give no importer a claim, so nothing but this orders them — and
   * reverse registration alone does not, since a singleton is registered when
   * the FIRST import reaches it, which for an import declared inside another
   * library is after that library's own context. `TEARDOWN_LAST` on the context
   * is what keeps a singleton alive until the libraries borrowing it have gone.
   *
   * Its protection now stops at library-against-library. Every resource of the
   * context that owns the sweep has already unwound by the time it runs, which
   * is the ordering the sweep used to invert.
   */
  private childTeardownOrder(): IEvaluationContext[] {
    return [...this.children]
      .reverse()
      .sort(
        (a, b) =>
          ((a as { teardownPriority?: number }).teardownPriority ?? 0) -
          ((b as { teardownPriority?: number }).teardownPriority ?? 0),
      );
  }

  /**
   * Resource instances in teardown order: ascending `teardownPriority` as a hard
   * tier, and within a tier a consumer before every resource it holds
   * ({@link reverseTopologicalOrder} over the create-time edges), with reverse
   * insertion as the tiebreak.
   *
   * `teardownPriority` is a TIER rather than another edge because it is the
   * author's statement about an edge nothing captured: a log sink is reached
   * through `ctx.log` rather than through a ref slot, so no walk of the manifest
   * can find the resources that will log on the way down. Letting topology
   * reorder across tiers would let one discovered edge override a declaration
   * made precisely because the edges are not all discoverable.
   */
  private teardownOrder(): Array<readonly [string, { resource: any; instance: any }]> {
    // A borrowed instance is torn down by the scope that declared it, never
    // here — see `borrowedResources`.
    const entries = [...this.resourceInstances.entries()]
      .filter(([name]) => !this.borrowedResources.has(name))
      .reverse();
    const tiers = new Map<number, Array<readonly [string, { resource: any; instance: any }]>>();
    for (const entry of entries) {
      const priority = (entry[1].instance as { teardownPriority?: number })?.teardownPriority ?? 0;
      const tier = tiers.get(priority);
      if (tier) tier.push(entry);
      else tiers.set(priority, [entry]);
    }
    return [...tiers.keys()]
      .sort((a, b) => a - b)
      .flatMap((priority) =>
        reverseTopologicalOrder(
          tiers.get(priority)!,
          (value) => value.resource.metadata.name as string,
          (name) => this.heldDependencies(name),
        ),
      );
  }

  /** What `name` holds of the resources it depends on, in teardown's sense: its
   *  dependencies without the names it reaches only as a declaration read. */
  private heldDependencies(name: string): readonly string[] | undefined {
    const all = this.resourceDependencies.get(name);
    const declarationOnly = declarationReadsOf(this.resourceInstances.get(name)?.resource);
    if (!all || !declarationOnly) return all;
    const reads = this.readDependencies.get(name);
    return all.filter((dependency) => !declarationOnly.has(dependency) || reads?.has(dependency) === true);
  }

  /**
   * Every resource of this context that becomes invalid when `names` do — the
   * named resources plus everything that transitively holds one
   * ({@link impactClosure} over the same create-time edges teardown reads).
   *
   * What a reconciliation unwinds. A cross-module reference projects onto the
   * local `Telo.Import` (`localDependencyNames`), so a change inside an
   * imported library reaches this context as its import being impacted, and the
   * library goes down with that import's own inverse — which is why this
   * answers for one context rather than walking the tree.
   *
   * **`opaque` is what the answer cannot cover.** A name resolved by NAME during
   * initialization ({@link opaquelyRead}) may be held by a resource no edge
   * names, so a closure reaching one is not an answer at all. Those names are
   * reported rather than absorbed: expanding the set to "every resource here"
   * would sweep in the module document, which is not a resource a caller can
   * unwind and re-register, and would present a whole-context rebuild as a
   * narrowing. The caller escalates, and can say which resource forced it.
   */
  // eslint-disable-next-line @typescript-eslint/member-ordering
  impactedBy(names: Iterable<string>): { impacted: Set<string>; opaque: string[] } {
    const impacted = impactClosure(names, this.resourceDependencies);
    const opaque = [...impacted].filter((name) => this.opaquelyRead.has(name));
    return { impacted, opaque };
  }

  /** Whether this resource's `run()` has been dispatched. A rebuilt resource
   *  that had been started is one nothing will start again — boot targets run
   *  once — so a caller reconciling has to escalate rather than leave it
   *  constructed and idle. */
  wasStarted(name: string): boolean {
    const instance = this.resourceInstances.get(name)?.instance;
    return instance !== undefined && startedInstances.has(instance);
  }

  /** Drop a resource's published reading. A context with no `resources` scope of
   *  its own has nothing to drop; `ModuleContext` overrides. */
  clearPublishedReading(name: string): void {
    void name;
  }

  /** The declaration registered under `name` in THIS context, without the
   *  walk up the enclosing chain a name lookup does. */
  declaredManifestFor(name: string): ResourceManifest | undefined {
    return this.declaredManifests.get(name);
  }

  /** Replace a declaration in place, without queueing the resource for
   *  creation. For a survivor of a reconciliation: its declaration is
   *  content-identical by construction, but the object carries fresh loader
   *  stamps (`metadata.sourceLine` above all), and a diagnostic anchored on the
   *  stale one points at a pre-edit line. */
  refreshManifest(name: string, resource: ResourceManifest): void {
    if (!this.declaredManifests.has(name)) return;
    this.declaredManifests.set(name, resource);
    recordDeclarationScope(resource, this);
  }

  /** Re-open an initialized context for another initialization pass.
   *
   *  The transition is the context's own, not a field a caller assigns: while it
   *  is open, a reference to a resource that has not been rebuilt yet must
   *  produce the deferral the init loop retries on rather than a hard
   *  not-found, and leaving it open after a failed pass turns every later
   *  lookup into that deferral with no pass coming. */
  reopenForInitialization(): void {
    if (this.state === "Initialized") this.state = "Validated";
  }

  /** Close a pass opened by {@link reopenForInitialization} that did not reach
   *  the end of `initializeResources`. */
  closeInitialization(): void {
    if (this.state === "Validated") this.state = "Initialized";
  }

  /** Names a resource resolved by NAME while this context was initializing, so
   *  no edge records who is holding them. Read by {@link impactedBy}; exposed so
   *  a host can report why a reconciliation could not be narrowed. */
  opaqueReads(): ReadonlySet<string> {
    return this.opaquelyRead;
  }

  transientChild(context: Record<string, any>): EvaluationContext {
    return new EvaluationContext(
      this.source,
      { ...this.context, ...context },
      this._createInstance,
      this._secretValues,
      this.emit,
    );
  }

  /**
   * Invoke a resource by kind and name within this context's resourceInstances.
   * Emits a scoped Invoked/InvokeRejected/InvokeFailed event via the injected
   * emit callback. The single emission point for invoke-level events — callers
   * holding an already-resolved instance should use invokeResolved() instead.
   */
  async invoke<TInputs>(
    kind: string,
    name: string,
    inputs: TInputs,
    ctx?: InvokeContext,
    caller?: DispatchCaller,
  ): Promise<any> {
    const entry = this.resourceInstances.get(name);

    if (!entry) {
      // A MISS ON A RESOURCE THE RUNTIME WITHDREW is the runtime going away, not
      // a manifest defect, and the two want opposite follow-ups. An unwind
      // removes each instance as it goes, so work still in flight — a detached
      // task the kernel waited for and then abandoned, above all — finds an
      // emptying map and would otherwise be told its target does not exist. That
      // verdict is durable where the withdrawal is not: a durable run records it
      // as `failed`, which is terminal, so one ordinary Ctrl-C leaves a run id
      // nothing will ever pick up again — from the one feature whose whole
      // purpose is surviving that.
      //
      // Reported as a cancellation because that is what it is, and because every
      // consumer already handles one correctly: a durable body leaves the run
      // `running` for the resumer, and a step's retry budget is not spent
      // re-issuing a call the runtime has no intention of answering.
      //
      // Keyed on `unwoundResources` — the recorded FACT — rather than on this
      // context's state, which is only a proxy for it and misses the
      // reconciliation path entirely: `unwindResources` withdraws an instance and
      // deliberately leaves the state alone, and that is the path a watch session
      // takes on every save. Only the MISS is converted; a resource still in the
      // map is dispatched as before, because a teardown-time flush is legitimate
      // work and refusing it would break shutdown to protect it.
      if (this.unwoundResources.has(name)) {
        const reason =
          this.state === "Draining" || this.state === "Teardown"
            ? "the runtime is shutting down"
            : "the resource was unwound while the runtime reconciled";
        // The SPAN payload, not an ad-hoc object: every consumer of this event
        // reads `ref.kind` (the debug UI's kind facet) and `outcome` (its graph
        // nodes and outcome tally) off the trace shape, so a payload carrying
        // neither is an event that fires and is invisible — which is worse than
        // no event, and precisely the cancellation an operator is looking for
        // during a watch-session save. No span ids: this refusal happens before
        // any span is opened, and `tracePayload` omits an undefined one.
        await this.emitSpan(
          `${name}.InvokeCancelled`,
          () => this.tracePayload(kind, name, undefined, undefined, undefined, "invoke", "end", "cancelled", {
            reason,
          }),
        );
        throw new RuntimeError(
          "ERR_INVOKE_CANCELLED",
          `Invoke ${kind}.${name} was cancelled: ${reason} and the resource has already ` +
            `been torn down.`,
        );
      }
      throw this.refusedDispatch(
        new RuntimeError(
          "ERR_RESOURCE_NOT_FOUND",
          `Resource not found for invocation: ${kind}.${name}. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
        ),
        caller,
        ctx,
      );
    }

    // A `!ref` whose kind couldn't be determined at resolve time (e.g. a
    // scope-local target absent from the static manifest set) arrives with an
    // empty kind; dispatch is by name, so recover the authoritative kind from
    // the resolved entry for event topics and error messages.
    const effectiveKind = kind || (entry.resource.kind as string);

    if (
      typeof entry.instance.invoke !== "function" &&
      typeof entry.instance.run !== "function"
    ) {
      throw this.refusedDispatch(
        new RuntimeError(
          "ERR_RESOURCE_NOT_INVOKABLE",
          `Resource ${effectiveKind}.${name} does not have an invoke or run method`,
        ),
        caller,
        ctx,
      );
    }

    return this.runInvoke(effectiveKind, name, entry.instance, inputs, ctx, caller);
  }

  /**
   * Like invoke(), but the caller has already resolved the instance (e.g. the
   * scope path in Run.Sequence, or the live-injected Http.Api route handler).
   * Shares the single emission point so events fire exactly once per call
   * regardless of which path reached the instance.
   */
  async invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    ctx?: InvokeContext,
    caller?: DispatchCaller,
  ): Promise<any> {
    if (typeof instance.invoke !== "function" && typeof instance.run !== "function") {
      throw this.refusedDispatch(
        new RuntimeError(
          "ERR_RESOURCE_NOT_INVOKABLE",
          `Resource ${kind}.${name} does not have an invoke or run method`,
        ),
        caller,
        ctx,
      );
    }
    return this.runInvoke(kind, name, instance, inputs, ctx, caller);
  }

  /**
   * Build the structured trace payload every capability dispatch emits. The
   * event *name* stays human-meaningful (`<name>.Invoked`) for bus subscribers;
   * everything a debug consumer needs to rebuild the call tree rides here, so the
   * consumer never parses the dotted name. `spanId`/`parentSpanId` are the
   * tracer's `invocationId`/`parentInvocationId`, rendered as 16 lowercase hex
   * characters at this boundary (present only while tracing) so a span joins its
   * log records by string equality — see kernel/specs/logging.md §7.1;
   * `ref` carries the kind+name the name no longer encodes; `detail` is the
   * per-capability data (inputs/outputs, error fields, cancellation reason).
   */
  /**
   * A redacted snapshot of the CEL root scope a debug consumer should see for a
   * trace — `variables`, masked `secrets`, resource `snapshots`, `ports`. Attached
   * to a trace's *root* span so the consumer can inspect what data the execution
   * could reference (beyond its own inputs/outputs). Only a `ModuleContext` owns a
   * root scope; child scopes return undefined.
   */
  protected traceRootScope(): Record<string, unknown> | undefined {
    return undefined;
  }

  protected tracePayload(
    kind: string,
    name: string,
    spanId: number | undefined,
    parentSpanId: number | string | undefined,
    traceId: string | undefined,
    capability: "invoke" | "run" | "provide" | "request",
    phase: "start" | "end",
    outcome: SpanOutcome | undefined,
    detail: Record<string, unknown>,
    views?: Readonly<Record<string, (value: unknown) => unknown>>,
    /** The scope-run redaction that applies to this dispatch, when one does. */
    runScrub?: (value: unknown) => unknown,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      traceId,
      // The counter stays a cheap integer internally; hex is a fixed-width
      // render performed only here, at the encoding boundary, and only for
      // spans actually being emitted (§7.1 forbids formatting eagerly at span
      // creation). The salt keeps ids unique across processes in one trace.
      spanId: spanId === undefined ? undefined : formatSpanCounter(spanId),
      // A string is an upstream span's id, already in its emitted form.
      parentSpanId:
        typeof parentSpanId === "string"
          ? parentSpanId
          : parentSpanId === undefined
            ? undefined
            : formatSpanCounter(parentSpanId),
      capability,
      phase,
      ...(outcome !== undefined ? { outcome } : {}),
      ref: { kind, name, id: this.resourceId(kind, name) },
      ...(this.owner ? { owner: this.owner } : {}),
    };
    // Inputs, outputs, error data and scope may hold a value built at dispatch, which
    // no redaction set knows: each is written by the value rule (logging §14).
    defineCensoredEntries(payload, detail, REDACTED, views, runScrub);
    return payload;
  }

  /** Emit a trace event whose payload is built only when something may listen: an
   *  `Invoked` goes out on every dispatch, and nothing is subscribed to most. */
  protected async emitSpan(event: string, payload: () => Record<string, unknown>): Promise<void> {
    if (mayReachListener(this.emit, event)) await this.emit(event, payload());
  }

  /** Hand a finished span to the attached trace sinks, when there are any. */
  protected exportSpan(span: FinishedSpan): void {
    const tracer = this.tracer;
    if (!tracer?.exporting) return;
    const record = spanRecordOf(span);
    if (record) tracer.finish(record);
  }

  /** The attributes the runtime puts on every dispatch span. */
  private dispatchSpanAttributes(kind: string, name: string): Record<string, unknown> {
    return { "telo.resource.kind": kind, "telo.resource.name": name };
  }

  private async runInvoke<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    ctx?: InvokeContext,
    /** The resource whose controller issued this dispatch: a failure leaving it
     *  is located in that resource's declaration, at `ctx.inputsAt`. */
    caller?: DispatchCaller,
  ): Promise<any> {
    // Explicit seed (trigger / embedder) wins; otherwise inherit the ambient
    // tree token; otherwise open a fresh, never-cancellable scope. The token
    // reaches the controller only as the explicit argument below.
    const ambient = cancellationStore.getStore();
    const baseCtx = ctx ?? ambient ?? UNCANCELLABLE_CONTEXT;
    const token = baseCtx.cancellation;

    // Tracing gate (a debug consumer is attached): mint a monotonic id for this
    // invocation, parent it to the ambient one, and ride both in every event's
    // payload so the consumer can rebuild the call tree. Off by default —
    // `invokeCtx` stays `baseCtx` and the fast `=== ambient` skip is preserved.
    const tracing = this.tracer?.enabled === true;
    const invocationId = tracing ? this.tracer!.next() : undefined;
    // Parent precedence mirrors the token: an explicit seed `ctx` wins, then the
    // ambient (ALS) invocation. A caller threading its own `ctx.invocationId` thus
    // has it honored as the parent, not silently dropped for the ALS value.
    const parentInvocationId = ctx?.invocationId ?? ambient?.invocationId;
    // Inherit the trace from the parent (explicit ctx wins, then ambient); mint a
    // fresh one only at a root. Carried on every span so an OTel exporter groups
    // the trace without walking the parent chain.
    const traceId = tracing
      ? (ctx?.traceId ?? ambient?.traceId ?? this.tracer!.newTraceId())
      : undefined;
    // Capture the root CEL scope once, on the trace's root span's terminal event.
    const rootScope = tracing && parentInvocationId === undefined ? this.traceRootScope() : undefined;
    const startTime = tracing ? nowUnixNano() : undefined;
    // The exported half of the span: identity, timing, outcome and attributes —
    // never inputs, outputs or scope. Declared attributes are read off the
    // values at the contract's marked properties.
    const finish = (
      outcome: SpanOutcome,
      extra: { outputs?: unknown; errorType?: string; cancellationReason?: string } = {},
    ) => {
      if (!tracing || !this.tracer?.exporting) return;
      this.exportSpan({
        name: `invoke ${name}`,
        traceId,
        spanId: invocationId,
        parentSpanId: parentInvocationId,
        startTime,
        endTime: nowUnixNano(),
        outcome,
        attributes: {
          ...this.dispatchSpanAttributes(kind, name),
          ...spanAttributesOf(instance, "inputType", inputs),
          ...(outcome === "ok" ? spanAttributesOf(instance, "outputType", extra.outputs) : {}),
          "error.type": extra.errorType,
          "telo.cancellation.reason": extra.cancellationReason,
        },
      });
    };
    // What a payload may say about this call. A credential is a dispatched
    // invocable, so its material is an invoke OUTPUT — and inputs and outputs
    // ride the debug wire on every call under `--inspect`, i.e. every watch
    // session, which the substring scrubbing does not reach (one call site, the
    // resource-Created event's properties). The kind that owns the contract
    // marks the field; nothing here knows which kind that is.
    const hide = (detail: Record<string, unknown>): Record<string, unknown> => {
      let out = detail;
      for (const direction of ["inputType", "outputType"] as const) {
        const key = direction === "inputType" ? "inputs" : "outputs";
        if (!(key in out)) continue;
        const paths = sensitivePathsOfInstance(instance, direction);
        // Unknown, because the contract would not resolve — withhold the whole
        // value rather than guess. The dispatch is about to raise that same
        // failure with its own code.
        if (paths === undefined) {
          out = { ...out, [key]: REDACTED };
          continue;
        }
        if (paths.length === 0) continue;
        out = { ...out, [key]: redactSensitive(out[key], paths) };
      }
      return out;
    };
    // A value of a type with members is shown as the dispatch builds it, so text at a
    // `Telo.Url` slot carrying a password is censored like the value it becomes.
    const payloadViews = {
      inputs: (value: unknown) => payloadViewOf(instance, "inputType", value),
      outputs: (value: unknown) => payloadViewOf(instance, "outputType", value),
    };
    // A scope run's values are redacted from the payload of a dispatch whose
    // target the run created, of one the holder issues inside the run (its
    // per-dispatch `scopeRun`), of the opening dispatch — whose run's values are
    // its own sensitive inputs — and of a failure that left a run. Read when the
    // payload is built, so it costs nothing where nothing listens.
    let failure: unknown;
    const openingRedaction = (): RunRedaction | undefined => {
      if (!opensDispatchScope(instance)) return undefined;
      const own = textsAtPaths(inputs, sensitivePathsOfInstance(instance, "inputType") ?? []);
      return own.length > 0 ? new RunRedaction(own, undefined) : undefined;
    };
    const runScrub = () =>
      combinedScrub([
        instanceRedactionOf(instance),
        redactionOfRun(ctx?.scopeRun),
        openingRedaction(),
        failure === undefined ? undefined : errorRedactionOf(failure),
      ]);
    const span = (
      phase: "start" | "end",
      outcome: SpanOutcome | undefined,
      detail: Record<string, unknown>,
    ) =>
      this.tracePayload(
        kind,
        name,
        invocationId,
        parentInvocationId,
        traceId,
        "invoke",
        phase,
        outcome,
        phase === "end" && rootScope ? { ...hide(detail), context: rootScope } : hide(detail),
        payloadViews,
        runScrub(),
      );
    // When tracing, a derived context carries the new id down the tree so nested
    // invokes read it as their parent; it is never `=== ambient`, so the call
    // always (re)establishes the ALS scope. Derived, never a fresh literal: a
    // literal drops every field it does not restate (`zones`), making
    // propagation differ between tracing on and off.
    // `inputsAt` names this call's inputs in the caller's declaration, so the
    // target's context never carries it on.
    // `calledAt` is the same kind of fact for the failure's trace: where the caller
    // makes this call, read here and handed on to nothing.
    const inputsAt = ctx?.inputsAt;
    const calledAt = ctx?.calledAt;
    // Every dispatch owns what reaches its body; its context carries that owner.
    const callerOwner = streamOwnerOf(baseCtx);
    const own = new StreamOwner(callerOwner, DISPATCH_ENDED);
    const invokeCtx: InvokeContext = deriveContext(
      baseCtx,
      tracing ? { invocationId, parentInvocationId, traceId, owner: own } : { owner: own },
    );
    // A dispatch under a context its issuer does not own is detached or a
    // trigger: what its inputs hold from the issuer's scope runs moves to it.
    const issuer = issuingOwnerOf(ambient);
    if (issuer !== undefined && callerOwner !== issuer) {
      if (issuerHolds(issuer)) {
        inputs = holdDetachedInputs(inputs, issuer, own, boundInputOf(instance)?.walkGuide()) as TInputs;
      }
      streamOwnerOf(ambient)?.releaseProvisional();
    }

    // Pre-dispatch gate: a sub-invoke reached after the tree was cancelled is
    // refused without ever touching the controller.
    if (token.isCancelled) {
      own.produce();
      await this.emitSpan(`${name}.InvokeCancelled`, () => span("end", "cancelled", { inputs, reason: token.reason }));
      finish("cancelled", { cancellationReason: token.reason ?? "cancelled" });
      throw new RuntimeError(
        "ERR_INVOKE_CANCELLED",
        `Invoke ${kind}.${name} was cancelled${token.reason ? `: ${token.reason}` : ""}`,
      );
    }

    // Start span — only under tracing, so non-traced behaviour stays exactly
    // one terminal event per call (subscribers to `<name>.Invoked` are unaffected).
    if (tracing) await this.emitSpan(`${name}.Invoking`, () => span("start", undefined, { inputs }));

    try {
      // Only (re)establish the ALS scope when the token differs from the ambient
      // one — nested invokes that inherited it skip the redundant `run`.
      // A step / boot-target slot may reference a pure Runnable (the schema
      // allows `telo#Runnable` alongside `telo#Invocable`); dispatch it via
      // `run()` — side effects only, no outputs. Prefer `invoke()` when both
      // exist so a dual-capability instance (e.g. Run.Sequence) keeps invoke
      // semantics and returns its `steps`/`outputs`.
      // A pure Runnable reached through an `invoke:` slot runs exactly as it
      // would from a `targets:` list, so it starts here too — its observed state
      // must not stay withheld just because the dispatch slot was a different one.
      if (typeof instance.invoke !== "function") await this.markStarted(name, instance);
      const call = () =>
        typeof instance.invoke === "function"
          ? (instance.invoke as (i: any, c?: InvokeContext) => any)(inputs as any, invokeCtx)
          : (instance.run as (c?: InvokeContext) => any)(invokeCtx);
      const produced = await cancellationStore.run(invokeCtx, call);
      // Only a dispatch still owning a held stream looks at what it returns.
      const outputs = own.ownsLive()
        ? holdReturned(produced, own, callerOwner, `${kind} '${name}'`, boundOutputOf(instance)?.walkGuide())
        : produced;
      own.produce();
      settleNeedObservations(instance, typeof instance.invoke === "function" ? "invoke" : "run");
      if (typeof instance.invoke !== "function") completedInstances.add(instance);
      await this.emitSpan(`${name}.Invoked`, () => span("end", "ok", { inputs, outputs }));
      finish("ok", { outputs });
      return outputs;
    } catch (err) {
      failure = err;
      own.produce();
      // Cooperative mid-flight cancellation (`throwIfCancelled`) joins the same
      // observable event family rather than masquerading as a rejection/failure.
      if (isCancellationError(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.emitSpan(`${name}.InvokeCancelled`, () => span("end", "cancelled", { inputs, reason }));
        finish("cancelled", { cancellationReason: reason });
        throw err;
      }
      // A SUSPENSION passes through untouched, exactly as a cancellation does,
      // and for a sharper reason. It is not a failure — it is the run leaving —
      // and the chokepoint is the one swallower that cannot be worked around:
      // EVERY dispatch between a parking kind and the workflow that owns the run
      // goes through here, so wrapping it once converts a park into an
      // `ERR_EXECUTION_FAILED` at every hop. The latch would then catch the
      // corruption at the boundary, which is a loud failure where nothing was
      // wrong.
      //
      // Reported as its own outcome rather than as a rejection: a parked
      // invocation neither succeeded nor failed, and a trace that recorded it
      // as failed would say the run broke every time it waited.
      if (isSuspension(err)) {
        await this.emitSpan(
          `${name}.InvokeParked`,
          () => span("end", "parked", { inputs, path: err.path, resource: err.resource }),
        );
        finish("parked");
        throw err;
      }
      if (isInvokeError(err)) {
        // The code's declared display message, and its data held to the declared schema:
        // one exit point for both, where the declared codes are checked too.
        const settled = this.errorDataValidator
          ? settleDisplayMessage(
              err,
              this.effectiveKindOf(kind),
              this.errorDataValidator,
              `${kind} '${name}'`,
            )
          : err;
        const detail = { inputs, code: settled.code, message: settled.message, data: settled.data };
        await this.emitSpan(`${name}.InvokeRejected`, () => span("end", "rejected", detail));
        const declaredCodes = this.getDeclaredThrowCodes(kind);
        if (declaredCodes && !declaredCodes.has(settled.code)) {
          await this.emitSpan(`${name}.InvokeRejected.Undeclared`, () => span("end", "rejected", detail));
        }
        finish("rejected", { errorType: settled.code });
        locateInvokeFailure(settled, caller, inputsAt);
        this.recordExit(settled, kind, name, instance, caller, calledAt);
        throw settled;
      }
      if (err instanceof Error) {
        await this.emitSpan(
          `${name}.InvokeFailed`,
          () => span("end", "failed", { inputs, name: err.name, message: err.message }),
        );
      } else {
        await this.emitSpan(
          `${name}.InvokeFailed`,
          () => span("end", "failed", { inputs, name: "UnknownError", message: String(err) }),
        );
      }
      finish("failed", { errorType: errorTypeOf(err) });
      // Already enriched at an inner invoke: keep the innermost (most
      // specific) resource as the failure location.
      if (err instanceof RuntimeError && err.diagnostics?.length) {
        this.recordExit(err, kind, name, instance, caller, calledAt);
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error ? err.name : undefined;
      // Keep `message` raw so callers (Run.Sequence catch blocks, assertions)
      // see the original error text unchanged. Resource context lives only on
      // the attached diagnostic, which the CLI's formatter renders as the
      // location prefix. Attach the original error as `cause` so
      // formatErrorForDiagnostic walks the chain and surfaces the underlying
      // stack and well-known error fields (AWS, pg, Node system errors).
      const diagnostic: RuntimeDiagnostic = {
        kind,
        resource: name,
        message,
        code,
        ...(caller ? { location: dispatchLocation(caller, inputsAt, undefined) } : {}),
      };
      if (caller) recordCallerDeclaration(diagnostic, caller);
      const wrapped = new RuntimeError("ERR_EXECUTION_FAILED", message, [diagnostic]);
      (wrapped as { cause?: unknown }).cause = err;
      // The wrapper carries the trace and the wrapped value keeps none.
      moveFailureFrames(err, wrapped);
      this.recordExit(wrapped, kind, name, instance, caller, calledAt);
      throw wrapped;
    }
  }

  /** A dispatch refused before it reached a target: the failure gains the caller's frame alone. */
  private refusedDispatch(err: RuntimeError, caller: DispatchCaller | undefined, ctx?: InvokeContext): RuntimeError {
    recordDispatchExit(err, () => this.failureGraph?.(), undefined, caller, ctx?.calledAt);
    return err;
  }

  /** The target of a dispatch as its frame names it — built only for a failure. */
  private dispatchTarget(kind: string, name: string, instance: ResourceInstance): DispatchCaller {
    const outermost = outermostDeclarationOf(instance);
    const declaration = outermost ? (authoredDeclarationOf(outermost) ?? outermost) : undefined;
    return {
      kind: this.resolveKindSafe(kind),
      name,
      ...(declaration ? { declaration } : {}),
    };
  }

  /** Add to a failure leaving a dispatch the frames of its target and its caller. */
  private recordExit(
    err: unknown,
    kind: string,
    name: string,
    instance: ResourceInstance,
    caller: DispatchCaller | undefined,
    calledAt: string | undefined,
  ): void {
    recordDispatchExit(
      err,
      () => this.failureGraph?.(),
      () => this.dispatchTarget(kind, name, instance),
      caller,
      calledAt,
    );
  }

  /**
   * The declared capability of a kind, or undefined if unknown. Definitions are
   * keyed by their canonical `<module>.<Kind>`, but a resource carries the alias
   * kind it was written with (`Http.Server`), so resolve the alias first.
   * Best-effort: `resolveKind` exists only on a `ModuleContext` and throws for
   * unqualified / ungated kinds, so guard and fall back to the raw kind.
   */
  /** Resolve an alias kind (`Http.Server`) to its canonical `<module>.<Kind>`.
   *  Only a `ModuleContext` carries the import-alias table; the base returns the
   *  kind unchanged. A typed seam (overridden in `ModuleContext`), matching the
   *  `traceRootScope()` pattern, rather than reaching across the boundary. */
  protected resolveKindSafe(kind: string): string {
    return this.kindResolver?.(kind) ?? kind;
  }

  /** Alias-kind resolver inherited from the context that spawned this one. A
   *  scope / template child holds no import table of its own, but its resources
   *  are written with the declaring module's aliases (`Observed.Listener`), so
   *  definition lookups there have to go through the parent's table. */
  kindResolver: ((kind: string) => string) | undefined;

  private capabilityOf(kind: string): string | undefined {
    return this.effectiveKindOf(kind)?.capability;
  }

  private getDeclaredThrowCodes(kind: string): Set<string> | null {
    if (!this.effectiveKind) return null;
    // An inheriting kind's block is its nearest ancestor's when it declares none.
    const effective = this.effectiveKindOf(kind);
    if (!effective) return null;
    const throws = effective.throws;
    if (!throws) return new Set();
    // inherit / passthrough unions are dynamic — resolved statically by the
    // analyzer, not re-derivable here without a manifest-wide traversal. Skip
    // the rule 9 check rather than mis-report every propagated code as
    // undeclared at runtime.
    if (throws.inherit || throws.passthrough) return null;
    const codes = throws.codes;
    if (!codes) return new Set();
    return new Set(Object.keys(codes));
  }

  async run(name: string, ctx?: InvokeContext, caller?: DispatchCaller, calledAt?: string): Promise<void> {
    const entry = this.resourceInstances.get(name);
    if (!(entry && typeof entry.instance.run === "function")) {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_RUNNABLE",
        `Resource ${name} is not runnable or not found. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
      );
    }
    return this.runInstance(entry.resource.kind as string, name, entry.instance, ctx, caller, calledAt);
  }

  /**
   * Like run(), but the caller has already resolved the instance (e.g. a
   * Phase-5-injected `!ref` boot target). Shares the single span-emitting path so
   * a pre-resolved runnable is instrumented exactly like a by-name dispatch
   * instead of escaping the chokepoint with a direct `instance.run()` call.
   */
  async runResolved(
    kind: string,
    name: string,
    instance: ResourceInstance,
    ctx?: InvokeContext,
  ): Promise<void> {
    if (typeof instance.run !== "function") {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_RUNNABLE",
        `Resource ${kind}.${name} does not have a run method`,
      );
    }
    return this.runInstance(kind, name, instance, ctx);
  }

  /**
   * Open a trace span a controller owns: an inbound boundary (an HTTP request),
   * or a unit of work inside a dispatch (an agent's model call). Mints a span,
   * emits its `start`, and returns a child context to thread into
   * `invokeResolved` so work dispatched under it nests beneath it.
   *
   * The parent is the upstream span of a valid `opts.inbound` `traceparent`
   * (logging spec §7.4: an invalid or all-zero one is ignored in full), else the
   * span `base` carries — so a span opened inside a dispatch is its child — else
   * none, and the span roots a fresh trace. An upstream parent id is exported
   * verbatim, never salted: it is another process's id. An inbound registrant
   * passes `rootContext()`, which carries no span. A no-op pass-through when
   * tracing is off.
   */
  async openSpan(base: InvokeContext | undefined, opts: OpenSpanOptions): Promise<OpenSpan> {
    const ctx = base ?? UNCANCELLABLE_CONTEXT;
    if (this.tracer?.enabled !== true) {
      return { context: ctx, settle: async () => {} };
    }
    const spanId = this.tracer.next();
    const upstream = opts.inbound
      ? parseTraceParent(opts.inbound.traceparent, opts.inbound.tracestate)
      : undefined;
    const underBase = opts.inbound === undefined && ctx.traceId !== undefined;
    const traceId = upstream?.traceId ?? (underBase ? ctx.traceId! : this.tracer.newTraceId());
    const localParentSpanId = underBase ? ctx.invocationId : undefined;
    const parentSpanId: number | string | undefined = upstream?.parentSpanId ?? localParentSpanId;
    // A carrier taken under this span hands the upstream's flags and state on.
    const releaseUpstream = upstream
      ? this.tracer.continueUpstream(traceId, upstream.traceFlags, upstream.traceState)
      : undefined;
    const startTime = nowUnixNano();
    // A local root (no parent in this process) carries the root scope.
    const rootScope = localParentSpanId === undefined ? this.traceRootScope() : undefined;
    const detail = {
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.attributes !== undefined ? { attributes: opts.attributes } : {}),
    };
    const payload = (
      phase: "start" | "end",
      outcome: SpanOutcome | undefined,
      extra: Record<string, unknown> = {},
    ) =>
      this.tracePayload(
        opts.ref.kind,
        opts.ref.name,
        spanId,
        parentSpanId,
        traceId,
        "request",
        phase,
        outcome,
        { ...detail, ...extra },
      );

    await this.emitSpan(`${opts.ref.name}.Requesting`, () => payload("start", undefined));
    // Derived so the span context keeps whatever `base` carries beyond the span
    // ids — with tracing off this method returns `base` unchanged, and tracing
    // must not change what propagates.
    const context: InvokeContext = deriveContext(ctx, {
      invocationId: spanId,
      parentInvocationId: localParentSpanId,
      traceId,
    });
    let settled = false;
    return {
      context,
      settle: async (outcome, extra?: SpanSettleDetail) => {
        if (settled) return;
        settled = true;
        releaseUpstream?.();
        const attributes: Record<string, unknown> = { ...opts.attributes, ...extra?.attributes };
        if (outcome === "cancelled" && attributes["telo.cancellation.reason"] === undefined) {
          attributes["telo.cancellation.reason"] = ctx.cancellation.reason ?? "cancelled";
        }
        const end = { ...extra, ...(Object.keys(attributes).length > 0 ? { attributes } : {}) };
        await this.emitSpan(
          `${opts.ref.name}.Request`,
          () => payload("end", outcome, rootScope ? { ...end, context: rootScope } : end),
        );
        this.exportSpan({
          name: opts.label ?? opts.ref.name,
          traceId,
          spanId,
          parentSpanId,
          startTime,
          endTime: nowUnixNano(),
          outcome,
          attributes,
        });
      },
    };
  }

  /**
   * The span `ctx` carries — else the ambient one — as a W3C carrier, which
   * `openSpan(…, { inbound })` continues as that span's child. Nothing when tracing
   * is off or no span is current.
   */
  traceCarrier(ctx?: InvokeContext): TraceCarrier | undefined {
    if (this.tracer?.enabled !== true) return undefined;
    const current = ctx ?? cancellationStore.getStore();
    if (current?.traceId === undefined || current.invocationId === undefined) return undefined;
    return this.tracer.carrier(current.traceId, current.invocationId);
  }

  private async runInstance(
    kind: string,
    name: string,
    instance: ResourceInstance,
    ctx?: InvokeContext,
    caller?: DispatchCaller,
    calledAt?: string,
  ): Promise<void> {
    const ambient = cancellationStore.getStore();
    const baseCtx = ctx ?? ambient ?? UNCANCELLABLE_CONTEXT;
    const token = baseCtx.cancellation;

    // A long-lived Service's `run()` is not a one-shot dispatch: it stays pending
    // for the process lifetime, so wrapping it in the cancellation/trace ALS scope
    // would leak that scope onto every async resource the service creates (e.g. an
    // HTTP server's listening socket → every inbound request callback). Such a
    // service must NOT establish an ambient: its token reaches it via the explicit
    // `run(invokeCtx)` argument (how it observes shutdown), and its externally
    // triggered work then starts with a clean ambient — separate traces, no
    // inherited cancellation. Runnables (one-shot, e.g. `Run.Sequence`) keep the
    // ALS scope so their steps nest and inherit cancellation.
    const isService = this.capabilityOf(kind) === "Telo.Service";

    // Span instrumentation mirrors `runInvoke` — minting an id here makes
    // Runnables (a `Run.Sequence` boot target) appear in the trace and re-parents
    // their nested invokes. A long-lived Service emits only the `start` span (its
    // `run()` resolves at teardown), the "running" signal a debug consumer wants.
    const tracing = this.tracer?.enabled === true;
    const invocationId = tracing ? this.tracer!.next() : undefined;
    const parentInvocationId = ctx?.invocationId ?? ambient?.invocationId;
    const traceId = tracing
      ? (ctx?.traceId ?? ambient?.traceId ?? this.tracer!.newTraceId())
      : undefined;
    const rootScope = tracing && parentInvocationId === undefined ? this.traceRootScope() : undefined;
    const startTime = tracing ? nowUnixNano() : undefined;
    const finish = (
      outcome: "ok" | "failed" | "cancelled",
      extra: { errorType?: string; cancellationReason?: string } = {},
    ) => {
      if (!tracing) return;
      this.exportSpan({
        name: `run ${name}`,
        traceId,
        spanId: invocationId,
        parentSpanId: parentInvocationId,
        startTime,
        endTime: nowUnixNano(),
        outcome,
        attributes: {
          ...this.dispatchSpanAttributes(kind, name),
          "error.type": extra.errorType,
          "telo.cancellation.reason": extra.cancellationReason,
        },
      });
    };
    let failure: unknown;
    const span = (
      phase: "start" | "end",
      outcome: "ok" | "failed" | "cancelled" | undefined,
      detail: Record<string, unknown>,
    ) =>
      this.tracePayload(
        kind,
        name,
        invocationId,
        parentInvocationId,
        traceId,
        "run",
        phase,
        outcome,
        phase === "end" && rootScope ? { ...detail, context: rootScope } : detail,
        undefined,
        combinedScrub([
          instanceRedactionOf(instance),
          failure === undefined ? undefined : errorRedactionOf(failure),
        ]),
      );
    const own = new StreamOwner(streamOwnerOf(baseCtx), DISPATCH_ENDED);
    const invokeCtx: InvokeContext = deriveContext(
      baseCtx,
      tracing ? { invocationId, parentInvocationId, traceId, owner: own } : { owner: own },
    );

    // Refuse a target reached after the boot run was cancelled.
    if (token.isCancelled) {
      own.produce();
      await this.emitSpan(`${name}.RunCancelled`, () => span("end", "cancelled", { reason: token.reason }));
      finish("cancelled", { cancellationReason: token.reason ?? "cancelled" });
      throw new RuntimeError(
        "ERR_INVOKE_CANCELLED",
        `Run ${kind}.${name} was cancelled${token.reason ? `: ${token.reason}` : ""}`,
      );
    }

    if (tracing) await this.emitSpan(`${name}.Running`, () => span("start", undefined, {}));

    // Marked before the call, not after: a Service's `run()` stays pending for
    // the process lifetime, and reporting what it discovered while listening is
    // the whole point — `ctx.setStatus()` is an error until the resource counts
    // as started, so this has to happen first.
    await this.markStarted(name, instance);

    // A frame of its own: what `run()` allocates (a listening socket, a kernel
    // hold) is undone when the run's frame unwinds, without disturbing what
    // `init()` built underneath it.
    const effects = effectOwnerOf(instance)?.effects;
    effects?.openFrame("run");

    try {
      // Runnable: run inside the ALS scope so nested invokes inherit the token and
      // trace id (skip the redundant `run` when the token is already ambient).
      // Service: call directly with the explicit context and NO ambient scope, so
      // its long-lived async work does not capture this scope.
      // What `run()` returns is what undoes it — the socket it opened, the hold
      // it took. The chain executes INSIDE the same ambient scope as the call
      // that produced it: its bodies are the work `run()` would otherwise have
      // done inline, so running them outside would silently strip the
      // cancellation token and trace parent from exactly the code that moved
      // into a chain.
      const call = async () => {
        const returned = await (instance.run as (c?: InvokeContext) => Promise<unknown>)(invokeCtx);
        await executeReturnedChain(returned, effects);
      };
      // A Service's run() leaves no ambient behind for the work it registers.
      await (isService ? cancellationStore.exit(call) : cancellationStore.run(invokeCtx, call));
      own.produce();
      settleNeedObservations(instance, "run");
      // A one-shot Runnable that discovered something during run() publishes it
      // without an explicit call; a Service never reaches this until teardown.
      completedInstances.add(instance);
      await this.publishSnapshot(name);
      await this.emitSpan(`${name}.Run`, () => span("end", "ok", {}));
      finish("ok");
    } catch (err) {
      failure = err;
      own.produce();
      // A run that did not complete leaves nothing of its own behind: its frame
      // unwinds here, so a `listen()` that threw releases the hold it took a
      // line earlier instead of holding the process open for a server that
      // never came up.
      const refused = (await effects?.unwindFrame()) ?? [];
      const recovery =
        refused.length > 0
          ? {
              recoveryFailures: refused.map((f) => ({
                reason: f.reason,
                message: errorText(f.error),
              })),
            }
          : {};
      if (isCancellationError(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.emitSpan(`${name}.RunCancelled`, () => span("end", "cancelled", { reason, ...recovery }));
        finish("cancelled", { cancellationReason: reason });
        throw err;
      }
      const detail =
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: "UnknownError", message: String(err) };
      await this.emitSpan(`${name}.RunFailed`, () => span("end", "failed", { ...detail, ...recovery }));
      finish("failed", { errorType: errorTypeOf(err) });
      this.recordExit(err, kind, name, instance, caller, calledAt);
      throw err;
    }
  }

  /**
   * Run `fn` detached from the caller's cancellation/trace scope. The current
   * ambient `InvokeContext` (a request's token + span) is replaced with the
   * uncancellable root, so request-scope teardown cannot abort the work and it
   * does not nest under the request's trace. This is the bare scope primitive —
   * tracking/draining a detached task is the owning resource's concern (the
   * per-resource `ResourceContext` records the task and drains it in the
   * resource's teardown).
   */
  runDetached<T>(fn: () => Promise<T>): Promise<T> {
    // The task owns what its dispatches return to it, closing when it settles,
    // and holds what its issuer holds until its first dispatch has walked its
    // inputs — a stream in them keeps its scope open from there.
    const issuer = issuingOwnerOf(cancellationStore.getStore());
    const task = new StreamOwner(issuer, DETACHED_TASK_ENDED, issuer);
    if (issuerHolds(issuer)) task.holdProvisionally(holdersOf(issuer));
    const settle = (): void => {
      task.releaseProvisional();
      task.produce();
    };
    return cancellationStore
      .run(deriveContext(UNCANCELLABLE_CONTEXT, { owner: task }), fn)
      .finally(settle);
  }

  /**
   * Expand a value that may contain precompiled ${{ }} templates.
   *
   * Hot path: each unique manifest subtree is compiled once into a tightly-bound
   * walker closure (no per-call `isCompiledValue` / `Array.isArray` / `typeof` /
   * `Object.entries` overhead, no recursive method dispatch). The walker tree is
   * cached by the input value's identity in `walkerCache`, so subsequent calls
   * with the same manifest data reuse it. The walker reads from `this._context`
   * — which `expandWith` mutates in place — and emits a fresh container per call
   * to preserve the original recursive `expand`'s semantics.
   */
  expand(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const cached = this.walkerCache.get(value as object);
    if (cached) return cached(this._context);
    const walker = compileWalker(value);
    this.walkerCache.set(value as object, walker);
    return walker(this._context);
  }

  /**
   * Expand a value using this context merged with additional properties.
   *
   * Hot path optimisation: rather than allocate a fresh prototype-less object
   * per call (one allocation + N property copies for N keys in the saved
   * context), we mutate `_context` in place — adding or overwriting only the
   * `extraContext` keys — and restore the previous values on exit. Safe because
   * `expand` is synchronous; cel-vm closures only read from the activation.
   */
  expandWith(value: unknown, extraContext: Record<string, unknown>): unknown {
    if ((extraContext as Record<symbol, unknown>)[LAZY_SCOPE] === true) {
      return this.expandWithLazyScope(value, extraContext);
    }
    const ctx = this._context as Record<string, unknown>;
    const keys = Object.keys(extraContext);
    const savedValues: unknown[] = new Array(keys.length);
    const hadKey: boolean[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      hadKey[i] = k in ctx;
      if (hadKey[i]) savedValues[i] = ctx[k];
      // The one point a host's own value enters an activation, so the one point it is
      // brought into the value domain — a framework's bag is prototype-free data the
      // member-read seam cannot read. Identity where nothing moved: see
      // `cel-host-scope-value.ts` for why only that one shape converts.
      ctx[k] = celHostScopeValue(extraContext[k]);
    }
    try {
      return this.expand(value);
    } finally {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (hadKey[i]) ctx[k] = savedValues[i];
        else delete ctx[k];
      }
    }
  }

  /**
   * `value`, evaluated in THIS context wherever it is later called: the module
   * globals are this context's, the call's own bindings (`inputs`, `steps`,
   * `error`, …) are the caller's, and `bound` is added on top. A failure names
   * where the expression was written.
   */
  boundExpression(value: CompiledValue, bound: Record<string, unknown>, where: string): CompiledValue {
    return {
      ...value,
      call: (activation: Record<string, unknown>) => {
        const scope: Record<string, unknown> = {};
        for (const key of Object.keys(activation)) {
          if (key in this._context || MODULE_GLOBAL_NAMES.has(key)) continue;
          scope[key] = activation[key];
        }
        try {
          return this.expandWith(value, { ...scope, ...bound });
        } catch (error) {
          if (error instanceof Error) error.message = `in ${where}: ${error.message}`;
          throw error;
        }
      },
    };
  }

  /**
   * `expandWith` for a scope carrying accessor properties (a {@link bindScope}
   * result). Transfers property *descriptors* rather than values, so a binding's
   * getter reaches the activation intact and is called only if the expression
   * reads it. The value-copying fast path above would force every getter at
   * merge time, which is exactly the eagerness lazy bindings avoid.
   */
  private expandWithLazyScope(value: unknown, extraContext: Record<string, unknown>): unknown {
    const ctx = this._context as Record<string, unknown>;
    const keys = Object.keys(extraContext);
    const saved: (PropertyDescriptor | undefined)[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      saved[i] = Object.getOwnPropertyDescriptor(ctx, key);
      Object.defineProperty(ctx, key, {
        ...Object.getOwnPropertyDescriptor(extraContext, key)!,
        configurable: true,
      });
    }
    try {
      return this.expand(value);
    } finally {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const previous = saved[i];
        if (previous) Object.defineProperty(ctx, key, previous);
        else delete ctx[key];
      }
    }
  }

  /**
   * Extend `base` with a kind's named CEL bindings, each evaluated lazily and
   * memoised for the lifetime of the returned scope. See
   * `ControllerContext.bindScope`.
   */
  bindScope(
    bindings: Record<string, unknown> | undefined,
    base: Record<string, unknown>,
  ): Record<string, unknown> {
    if (bindings === null || typeof bindings !== "object") return base;
    // A scope variable always wins — the caller's own (`inputs`, `item`) AND the
    // ambient ones on this context (`variables`, `resources`, …), which are not
    // in `base` and would otherwise be shadowed for the length of an expansion.
    // That is what bounds a name the analyzer's reserved-set check did not know
    // to reject: a dead binding, never a hijacked global.
    const names = Object.keys(bindings).filter(
      (name) => !(name in base) && !(name in this._context),
    );
    if (names.length === 0) return base;

    const scope: Record<string, unknown> = { ...base };
    const resolved = new Map<string, unknown>();
    const resolving = new Set<string>();
    for (const name of names) {
      Object.defineProperty(scope, name, {
        enumerable: true,
        configurable: true,
        get: () => {
          if (resolved.has(name)) return resolved.get(name);
          if (resolving.has(name)) {
            throw new RuntimeError(
              "ERR_BINDING_CYCLE",
              `Binding '${name}' resolves through itself (${[...resolving, name].join(" → ")}). ` +
                `A binding is computed from the ones it references, so the chain cannot close.`,
            );
          }
          resolving.add(name);
          try {
            const value = this.expandWith(bindings[name], scope);
            resolved.set(name, value);
            return value;
          } finally {
            resolving.delete(name);
          }
        },
      });
    }
    Object.defineProperty(scope, LAZY_SCOPE, { value: true });
    return scope;
  }

  /** Cache of compiled walker closures keyed on the manifest subtree they walk.
   *  WeakMap so entries are GC'd if the manifest is reloaded. */
  private readonly walkerCache = new WeakMap<
    object,
    (ctx: Record<string, unknown>) => unknown
  >();

/**
   * Expand specific dot-paths within an object. '**' expands the entire object.
   * Paths `excludePaths` overlap are left untouched (runtime takes precedence).
   * `holes` are fields left as written wherever they sit — an accessor field is
   * named, never evaluated — while everything beside one is still expanded.
   * Always throws if an expression cannot be resolved.
   */
  expandPaths(
    value: Record<string, unknown>,
    paths: string[],
    excludePaths: string[] = [],
    holes: readonly string[] = [],
  ): Record<string, unknown> {
    const around = holes.length > 0 ? holesIn(value, holes) : undefined;
    const expandAt = (node: unknown, parts: readonly string[]): unknown =>
      around ? this.expandAround(node, parts, around) : this.expand(node);
    if (paths.includes("**")) {
      const result: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        result[key] = isExcluded(key, excludePaths) ? v : expandAt(v, [key]);
      }
      return result;
    }
    const result = { ...value };
    for (const path of paths) {
      if (isExcluded(path, excludePaths)) continue;
      for (const parts of concreteEvalPaths(result, path, isCompiledValue)) {
        const current = getNestedValue(result, parts);
        if (current !== undefined) {
          setNestedValue(result, parts, expandAt(current, parts));
        }
      }
    }
    return result;
  }

  /** `node` expanded except at the holes it holds, copying each container on the
   *  way to one. */
  private expandAround(node: unknown, parts: readonly string[], holes: Holes): unknown {
    const key = parts.join(HOLE_SEPARATOR);
    if (holes.at.has(key) || holes.under(key)) return node;
    if (!holes.above.has(key)) return this.expand(node);
    if (Array.isArray(node)) return node.map((item, i) => this.expandAround(item, [...parts, String(i)], holes));
    if (node !== null && typeof node === "object" && !isCompiledValue(node)) {
      const proto = Object.getPrototypeOf(node);
      if (proto === Object.prototype || proto === null) {
        return Object.fromEntries(
          Object.entries(node as Record<string, unknown>).map(([k, v]) => [
            k,
            this.expandAround(v, [...parts, k], holes),
          ]),
        );
      }
    }
    return this.expand(node);
  }
}

const HOLE_SEPARATOR = "\0";

/** The concrete places a set of field patterns names in a value: each place,
 *  and every container above one. */
interface Holes {
  at: Set<string>;
  above: Set<string>;
  under(key: string): boolean;
}

function holesIn(value: Record<string, unknown>, patterns: readonly string[]): Holes {
  const at = new Set<string>();
  const above = new Set<string>();
  for (const pattern of patterns) {
    for (const parts of concreteEvalPaths(value, pattern, isCompiledValue)) {
      at.add(parts.join(HOLE_SEPARATOR));
      for (let i = 1; i < parts.length; i++) above.add(parts.slice(0, i).join(HOLE_SEPARATOR));
    }
  }
  const holes = [...at];
  return {
    at,
    above,
    under: (key) => holes.some((hole) => key.startsWith(`${hole}${HOLE_SEPARATOR}`)),
  };
}

/** A compile path is excluded from compile-time expansion when it overlaps a
 *  runtime path in either direction — the runtime path is a descendant of it, or
 *  vice versa. Both directions go through the shared {@link evalPathCovers}
 *  containment rule so this stays in lockstep with the analyzer's coverage check. */
function isExcluded(path: string, excludePaths: string[]): boolean {
  return excludePaths.some((ep) => evalPathCovers(ep, path) || evalPathCovers(path, ep));
}

function getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Sets a value beneath `obj`, copying each plain container on the way down so
 *  the manifest the expansion started from keeps its compiled expressions — an
 *  instance re-created from it must evaluate them again. */
function setNestedValue(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = current[parts[i]];
    if (next === null || typeof next !== "object") return;
    const proto = Object.getPrototypeOf(next);
    const copy = Array.isArray(next)
      ? [...next]
      : proto === Object.prototype || proto === null
        ? { ...(next as Record<string, unknown>) }
        : next;
    current[parts[i]] = copy;
    current = copy as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

type AccessToken = { kind: "id"; name: string } | { kind: "index"; index: number };

/**
 * Tokenize a CEL source string as a simple member-access path
 * (e.g. `steps.call.result.content[0].type`). Returns null when the source
 * contains anything beyond bare identifiers, dot access, and numeric/string
 * bracket access (function calls, operators, optionals, comprehensions, etc.)
 * — the enrichment is best-effort for the common dotted-path case.
 */
function tokenizeAccessPath(source: string): AccessToken[] | null {
  const s = source.trim();
  const idRe = /^[A-Za-z_][A-Za-z0-9_]*/;
  const root = idRe.exec(s);
  if (!root) return null;
  const tokens: AccessToken[] = [{ kind: "id", name: root[0] }];
  let i = root[0].length;
  while (i < s.length) {
    const c = s[i];
    if (c === ".") {
      i++;
      if (s[i] === "?") return null;
      const m = idRe.exec(s.slice(i));
      if (!m) return null;
      const afterId = i + m[0].length;
      if (s[afterId] === "(") return null;
      tokens.push({ kind: "id", name: m[0] });
      i = afterId;
    } else if (c === "[") {
      if (s[i + 1] === "?") return null;
      const close = s.indexOf("]", i);
      if (close === -1) return null;
      const inner = s.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) {
        tokens.push({ kind: "index", index: parseInt(inner, 10) });
      } else if (/^"[^"\\]*"$/.test(inner) || /^'[^'\\]*'$/.test(inner)) {
        tokens.push({ kind: "id", name: inner.slice(1, -1) });
      } else {
        return null;
      }
      i = close + 1;
    } else {
      return null;
    }
  }
  return tokens;
}

/**
 * Best-effort enrichment for CEL "no such key" failures. Walks the source
 * access path against the activation, finds the deepest reachable value, and
 * returns a single-line hint describing what was actually at that point
 * (object keys, array length, scalar type) so developers can immediately see
 * which segment of the chain produced an unexpected shape.
 *
 * Returns null when the error isn't a key-access failure, when the source
 * can't be parsed as a plain access path, or when the path can't be matched
 * against the activation — callers fall back to the original error text.
 */
export function describeFailedAccess(
  source: string,
  ctx: unknown,
  msg: string,
): string | null {
  const failure = locateFailedAccess(source, ctx, msg);
  if (!failure) return null;
  return `at ${failure.walked}: ${describeMissingAccess(failure.container, failure.missingKey)}`;
}

/**
 * The observed-state message for a failed access, or null when the failure has
 * nothing to do with observed state (the caller then falls back to the generic
 * enrichment above). See `observed-state.ts` for why "has not started" and
 * "started but reported nothing" are two different messages.
 */
export function describeObservedStateFailure(
  source: string,
  ctx: unknown,
  msg: string,
): string | null {
  const failure = locateFailedAccess(source, ctx, msg);
  if (!failure) return null;
  return diagnoseObservedStateAccess(failure.container, failure.missingKey);
}

/** Walk a dotted CEL access path against the activation and stop at the node
 *  whose key was missing. Null when the error isn't a key-access failure, the
 *  source isn't a plain access path, or the path doesn't match the activation. */
function locateFailedAccess(
  source: string,
  ctx: unknown,
  msg: string,
): { container: unknown; missingKey: string; walked: string } | null {
  const m = /^no such key: ("(?:[^"\\]|\\.)*")/.exec(msg);
  if (!m) return null;
  const missingKey: string = JSON.parse(m[1]);

  const tokens = tokenizeAccessPath(source);
  if (!tokens || tokens.length < 2) return null;
  if (tokens[0].kind !== "id") return null;
  if (typeof ctx !== "object" || ctx === null) return null;

  const rootName = tokens[0].name;
  if (!(rootName in (ctx as Record<string, unknown>))) return null;
  let current: unknown = (ctx as Record<string, unknown>)[rootName];
  const walked: string[] = [rootName];

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === "id") {
      if (
        current === null ||
        current === undefined ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        !(tok.name in (current as Record<string, unknown>))
      ) {
        if (tok.name !== missingKey) return null;
        return { container: current, missingKey, walked: walked.join("") };
      }
      current = (current as Record<string, unknown>)[tok.name];
      walked.push("." + tok.name);
    } else {
      if (current === null || current === undefined || typeof current !== "object") {
        return null;
      }
      current = (current as Record<number, unknown>)[tok.index];
      walked.push(`[${tok.index}]`);
    }
  }
  return null;
}

/** One line for an inverse's refusal, quoted into a recovery aggregate. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeMissingAccess(value: unknown, key: string): string {
  if (value === null) return `cannot read '${key}' — value is null`;
  if (value === undefined) return `cannot read '${key}' — value is undefined`;
  if (Array.isArray(value)) {
    return `cannot read '${key}' — value is an array of length ${value.length}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return `cannot read '${key}' — value is an empty object {}`;
    return `cannot read '${key}' — available keys: ${keys.join(", ")}`;
  }
  if (typeof value === "string") {
    const preview = value.length > 40 ? value.slice(0, 40) + "…" : value;
    return `cannot read '${key}' — value is a string (${JSON.stringify(preview)})`;
  }
  return `cannot read '${key}' — value is ${typeof value} (${String(value)})`;
}

/**
 * Build a detailed diagnostic from an arbitrary error. Walks the `cause` chain
 * and surfaces structured fields from well-known error shapes (AWS SDK
 * ServiceException, pg DatabaseError, Node system errors) so the user sees the
 * actual failure instead of just an opaque summary string.
 */
function formatErrorForDiagnostic(err: unknown): {
  message: string;
  code?: string;
  details?: string;
  children?: RuntimeDiagnostic[];
} {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }

  // A nested context's aggregate (an import initializing its library's
  // resources) already carries a classified diagnostic list. Keep it structured
  // instead of letting the cause-chain walk flatten it into this entry's
  // message: the child's root causes stay distinguishable from the child's own
  // cascade, and the error count sees the real leaves rather than one import.
  // The headline is re-derived from the diagnostics, never recovered by parsing
  // the message the child already rendered from them.
  if (
    err instanceof RuntimeError &&
    err.code === "ERR_RESOURCE_INITIALIZATION_FAILED" &&
    err.diagnostics?.length
  ) {
    return {
      message: summarizeInitFailures(err.diagnostics),
      code: err.code,
      children: err.diagnostics,
    };
  }

  // An `ERR_MANIFEST_VALIDATION_FAILED` carrying diagnostics — a library's analysis
  // refused by an import, or a template instance's expansion refused at `init()` —
  // keeps them structured the same way, each reported under its own code.
  if (
    err instanceof RuntimeError &&
    err.code === "ERR_MANIFEST_VALIDATION_FAILED" &&
    err.diagnostics?.length
  ) {
    return {
      message: `${err.diagnostics.length} manifest ${err.diagnostics.length === 1 ? "error" : "errors"}`,
      code: err.code,
      children: err.diagnostics,
    };
  }

  const detailLines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  let depth = 0;
  let topCode: string | undefined;
  let topMessage = "";

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const info = extractErrorInfo(current);
    if (depth === 0) {
      topMessage = info.summary;
      topCode = info.code;
    } else {
      detailLines.push(`Caused by: ${info.summary}`);
    }
    for (const field of info.fields) {
      detailLines.push(field);
    }
    current = (current as { cause?: unknown }).cause;
    depth++;
  }

  return {
    message: topMessage || err.message || err.name || String(err),
    code: topCode,
    details: detailLines.length ? detailLines.join("\n") : undefined,
  };
}

function extractErrorInfo(e: Error): { summary: string; code?: string; fields: string[] } {
  const fields: string[] = [];
  const anyE = e as unknown as Record<string, unknown>;

  const name = e.name && e.name.toLowerCase() !== "error" ? e.name : undefined;
  const code = anyE.code !== undefined && anyE.code !== null ? String(anyE.code) : undefined;
  const message = e.message && e.message.trim() ? e.message : "(no message)";

  const summary = name ? `${name}: ${message}` : message;

  const metadata = anyE.$metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata === "object") {
    if (metadata.httpStatusCode != null) fields.push(`HTTP status: ${metadata.httpStatusCode}`);
    if (metadata.requestId) fields.push(`Request ID: ${metadata.requestId}`);
    if (metadata.extendedRequestId) fields.push(`Extended request ID: ${metadata.extendedRequestId}`);
    if (metadata.cfId) fields.push(`CF ID: ${metadata.cfId}`);
    if (metadata.attempts != null) fields.push(`Attempts: ${metadata.attempts}`);
    if (metadata.totalRetryDelay != null) fields.push(`Total retry delay: ${metadata.totalRetryDelay}ms`);
  }
  if (anyE.$fault) fields.push(`Fault: ${String(anyE.$fault)}`);

  if (anyE.severity) fields.push(`Severity: ${String(anyE.severity)}`);
  if (anyE.detail) fields.push(`Detail: ${String(anyE.detail)}`);
  if (anyE.hint) fields.push(`Hint: ${String(anyE.hint)}`);
  if (anyE.schema) fields.push(`Schema: ${String(anyE.schema)}`);
  if (anyE.table) fields.push(`Table: ${String(anyE.table)}`);
  if (anyE.column) fields.push(`Column: ${String(anyE.column)}`);
  if (anyE.dataType) fields.push(`Data type: ${String(anyE.dataType)}`);
  if (anyE.constraint) fields.push(`Constraint: ${String(anyE.constraint)}`);
  if (anyE.routine) fields.push(`Routine: ${String(anyE.routine)}`);
  if (anyE.where) fields.push(`Where: ${String(anyE.where)}`);
  if (anyE.position) fields.push(`Position: ${String(anyE.position)}`);
  if (anyE.internalPosition) fields.push(`Internal position: ${String(anyE.internalPosition)}`);
  if (anyE.internalQuery) fields.push(`Internal query: ${String(anyE.internalQuery)}`);

  if (anyE.syscall) fields.push(`Syscall: ${String(anyE.syscall)}`);
  if (anyE.errno != null) fields.push(`Errno: ${String(anyE.errno)}`);
  if (anyE.address) fields.push(`Address: ${String(anyE.address)}`);
  if (anyE.port != null) fields.push(`Port: ${String(anyE.port)}`);
  if (anyE.hostname) fields.push(`Hostname: ${String(anyE.hostname)}`);
  if (anyE.path && !anyE.routine) fields.push(`Path: ${String(anyE.path)}`);

  return { summary, code, fields };
}
