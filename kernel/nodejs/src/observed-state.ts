import AjvModule from "ajv";
import { detachSnapshotValue, OBSERVED_STATE_KEY, RuntimeError } from "@telorun/sdk";

const Ajv = AjvModule.default ?? AjvModule;

/**
 * Publication of a resource's **observed state** — what it learns while running,
 * as opposed to what its author configured.
 *
 * The two arrive by different routes and this module keeps them apart.
 * Configured state is pulled from `snapshot()`; observed state is pushed through
 * `ResourceContext.setStatus()`, validated against the kind's `status:`, and
 * held by the kernel until the resource is torn down. Publication then joins
 * them: the flat half at `resources.<name>.<field>`, the reported half at
 * `resources.<name>.status.<field>`.
 *
 * Holding the reported value (rather than re-deriving it) is what makes the
 * reading *sticky*: a resource that learned its address once does not stop
 * knowing it because a later dispatch had nothing new to say.
 *
 * A non-enumerable {@link OBSERVED_STATE_INFO} marker rides along on the
 * published objects so a failed CEL read can say *why* the value is missing —
 * "has not started", "still running" and "finished and never reported it" need
 * different actions from the reader. It is a Symbol, so no CEL member access
 * can reach it.
 */
export const OBSERVED_STATE_INFO = Symbol("telo.observedState");

export interface ObservedStateInfo {
  /** The kind as written on the resource doc (`OAuthClient.RedirectListener`). */
  kind: string;
  name: string;
  /** Owning module, named in the "defect in someone else's module" message. */
  module?: string;
  /** The fields the kind declares it reports. */
  fields: string[];
  /** True once the resource's `run()` has been dispatched. */
  started: boolean;
  /** True once its `run()` has RETURNED. Never true for a long-lived Service,
   *  whose `run()` stays pending — which is what separates "still coming up"
   *  from "finished and reported nothing". */
  completed: boolean;
}

/** Read the marker off a published props / status object, if it carries one. */
export function observedStateInfo(value: unknown): ObservedStateInfo | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<symbol, ObservedStateInfo>)[OBSERVED_STATE_INFO];
}

function mark(target: Record<string, unknown>, info: ObservedStateInfo): void {
  Object.defineProperty(target, OBSERVED_STATE_INFO, {
    value: info,
    enumerable: false,
    configurable: true,
  });
}

const ajv = new Ajv({ allErrors: true, strict: false });
// Compiling a status schema costs ~ms and a resource may report repeatedly, so
// keep the validator keyed on the schema object it came from. The kind's folded
// `status:` is stamped once at registration, so this hits.
const validators = new WeakMap<object, ReturnType<typeof ajv.compile>>();

function validatorFor(schema: Record<string, any>): ReturnType<typeof ajv.compile> {
  let compiled = validators.get(schema);
  if (!compiled) {
    compiled = ajv.compile(schema);
    validators.set(schema, compiled);
  }
  return compiled;
}

/** The field names a `status:` schema declares, in declaration order. */
export function declaredStatusFields(schema: Record<string, any> | undefined): string[] {
  const props = schema?.properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

/**
 * Check a reported value against the kind's declared `status:` and detach it
 * from the controller. Called by `setStatus`, so an invalid report is refused at
 * the point it is made rather than at some later publication.
 */
export function acceptReportedStatus(
  status: Record<string, unknown>,
  opts: { kind: string; name: string; statusSchema?: Record<string, any> },
): Record<string, unknown> {
  if (!opts.statusSchema) {
    throw new RuntimeError(
      "ERR_OBSERVED_STATE_UNDECLARED",
      `${opts.kind} '${opts.name}' reported observed state, but the kind declares no 'status:' block. Declare it on the Telo.Definition (or on an abstract it extends) naming the fields this kind reports.`,
    );
  }
  const validate = validatorFor(opts.statusSchema);
  if (!validate(status)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
      .join("; ");
    throw new RuntimeError(
      "ERR_OBSERVED_STATE_INVALID",
      `${opts.kind} '${opts.name}' reported observed state that does not match its declared 'status:': ${detail}`,
    );
  }
  return detachSnapshotValue(status) as Record<string, unknown>;
}

export interface PublishOptions {
  kind: string;
  name: string;
  module?: string;
  /** The kind's effective `status:` (folded through `extends`), or undefined
   *  when nothing in the chain declares one. */
  statusSchema?: Record<string, any>;
  /** The last value the resource reported, or undefined if it has reported
   *  none. Already validated and detached by {@link acceptReportedStatus}. */
  status?: Record<string, unknown>;
  /** Whether the resource's `run()` has been dispatched. */
  started: boolean;
  /** Whether its `run()` has returned. */
  completed: boolean;
}

/**
 * Turn a `snapshot()` result plus the last reported status into the value
 * published at `resources.<name>`.
 *
 * Throws `ERR_OBSERVED_STATE_KEY_COLLISION` when a kind that declares `status:`
 * also returns a flat field of that name — the two would land on the same key,
 * and silently letting one win is worse than refusing. A kind that declares no
 * `status:` may use the name freely.
 */
export function buildPublishedProps(
  snapshot: Record<string, unknown> | undefined,
  opts: PublishOptions,
): Record<string, unknown> {
  const flat = (detachSnapshotValue(snapshot ?? {}) ?? {}) as Record<string, unknown>;

  if (!opts.statusSchema) return flat;

  if (OBSERVED_STATE_KEY in flat) {
    throw new RuntimeError(
      "ERR_OBSERVED_STATE_KEY_COLLISION",
      `${opts.kind} '${opts.name}' returns a '${OBSERVED_STATE_KEY}' field from snapshot(), but the kind declares a 'status:' block, which publishes at that same key. Rename the snapshot field, or drop the 'status:' declaration if the value is configuration rather than something the resource observes.`,
    );
  }

  const info: ObservedStateInfo = {
    kind: opts.kind,
    name: opts.name,
    module: opts.module,
    fields: declaredStatusFields(opts.statusSchema),
    started: opts.started,
    completed: opts.completed,
  };
  mark(flat, info);

  // Absent until the resource reports — so a read before then lands on a
  // message that says which of the three things went wrong, rather than on a
  // placeholder indistinguishable from a real reading.
  if (!opts.status) return flat;

  const published: Record<string, unknown> = { ...opts.status };
  mark(published, info);
  flat[OBSERVED_STATE_KEY] = published;
  return flat;
}

/**
 * The message for a failed `resources.<name>.status…` read, or null when the
 * failure has nothing to do with observed state.
 *
 * `container` is the value the access chain reached, `missingKey` the key that
 * was not there. Each cause gets its own message because they need different
 * actions from the reader, and the kernel — which records both whether the
 * resource started and whether its `run()` returned — is the only party that
 * can tell them apart:
 *
 *  - not started → order the `targets:` so it runs first;
 *  - started, still running → the read raced a resource that is still coming up
 *    (a Service binding asynchronously); reorder or read later;
 *  - `run()` returned and it never reported → the producing module declares
 *    something it does not report, and no edit here fixes that.
 */
export function diagnoseObservedStateAccess(
  container: unknown,
  missingKey: string,
): string | null {
  const info = observedStateInfo(container);
  if (!info) return null;

  if (missingKey === OBSERVED_STATE_KEY) {
    if (!info.started) {
      return `'${info.name}' reports ${formatFields(info.fields)} only while it is running, and it has not started yet. Read reported values where the call happens — a step's inputs:, a request's url, a route handler, or a returns: expression — and make sure '${info.name}' is listed in the targets: that runs before this value is read.`;
    }
    return info.completed
      ? `'${info.name}' finished running without ever reporting its observed state, which ${info.kind} declares it reports (${formatFields(info.fields)}). This is a defect in the ${info.module ?? "producing"} module — it never called setStatus, and no change to this manifest will fix it.`
      : `'${info.name}' has started but has not reported its observed state yet — it is still running, so this read raced it. Move the read after the point where '${info.name}' has reported.`;
  }

  if (info.fields.includes(missingKey)) {
    return `'${info.name}' reported observed state without '${missingKey}', which ${info.kind} declares it reports. Every declared field is mandatory once the resource has run — this is a defect in the ${info.module ?? "producing"} module, and no change to this manifest will fix it.`;
  }
  return `'${info.name}' reports no '${missingKey}'. It reports ${formatFields(info.fields)}.`;
}

function formatFields(fields: string[]): string {
  if (fields.length === 0) return "no observed state";
  return fields.map((f) => `'${f}'`).join(", ");
}
