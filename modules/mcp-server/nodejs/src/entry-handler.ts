import { type ResourceContext, type ResourceInstance, RuntimeError } from "@telorun/sdk";

export interface CapturedRef {
  kind: string;
  name: string;
}

/** What an entry of any bundle dispatches through, once its handler is live. */
export interface ResolvedHandler {
  inputs: Record<string, unknown>;
  result: Record<string, unknown>;
  catches?: CatchEntry[];
  handlerKind: string;
  handlerName: string;
  handler: ResourceInstance;
}

/** `when` is a compiled value for a `!cel` predicate and a bare boolean for a
 *  literal, so it is compared against `undefined`, never by truthiness. */
export interface CatchEntry {
  code?: string;
  when?: unknown;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Names one bundle kind in error codes and messages. */
export interface BundleLabel {
  /** `TOOLS` | `RESOURCES` | `PROMPTS` — the middle of `ERR_MCP_<code>_…`. */
  code: string;
  /** `Mcp.Tools[bundle]` */
  bundle: string;
  /** `tool` | `resource` | `prompt` */
  noun: string;
}

/** Capture a handler's {kind, name} at create(), before injection replaces the
 *  reference with the live instance. */
export function captureHandler(
  handler: unknown,
  ctx: ResourceContext,
  label: BundleLabel,
  entry: string,
): CapturedRef {
  if (handler && typeof handler === "object") return ctx.ensureKindRef(handler);
  // A bare name survives injection as the name; it is looked up at resolve time.
  if (typeof handler === "string") return { kind: "", name: handler };
  throw new RuntimeError(
    `ERR_MCP_${label.code}_INVALID`,
    `${label.bundle}: ${label.noun} '${entry}' missing handler`,
  );
}

/** The live handler of an entry, read after injection. */
export function resolveHandler(
  handler: unknown,
  ref: CapturedRef,
  ctx: ResourceContext,
  label: BundleLabel,
  entry: string,
): ResourceInstance {
  let instance: ResourceInstance | undefined;
  if (typeof handler === "string") {
    try {
      instance = ctx.moduleContext.getInstance(ref.name) as ResourceInstance;
    } catch (err) {
      throw new RuntimeError(
        `ERR_MCP_${label.code}_HANDLER_UNRESOLVED`,
        `${label.bundle}: ${label.noun} '${entry}' handler '${ref.name}' not found: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (handler && typeof handler === "object") {
    instance = handler as ResourceInstance;
  }
  // A reference injection could not resolve is left as {kind, name}, which has no `invoke`.
  if (!instance || typeof (instance as { invoke?: unknown }).invoke !== "function") {
    throw new RuntimeError(
      `ERR_MCP_${label.code}_HANDLER_UNRESOLVED`,
      `${label.bundle}: ${label.noun} '${entry}' handler '${ref.kind || "?"}.${ref.name}' did not resolve to a live Invocable`,
    );
  }
  return instance;
}

/** Refuse a matcher declared twice in one bundle. */
export function assertDistinct(matchers: string[], label: BundleLabel): void {
  const seen = new Set<string>();
  for (const matcher of matchers) {
    if (seen.has(matcher)) {
      throw new RuntimeError(
        `ERR_MCP_${label.code}_DUPLICATE`,
        `${label.bundle}: duplicate ${label.noun} '${matcher}' within the same bundle`,
      );
    }
    seen.add(matcher);
  }
}

/** What a transport reads from any bundle. `matchers` is known at create();
 *  `resolveEntries` only once handlers are live. */
export interface Bundle<Entry> {
  readonly bundleName: string;
  readonly matchers: string[];
  resolveEntries(): Entry[];
}

/** Narrow a transport's bundle slot to the live bundle injection put there. */
export function asBundle<B extends Bundle<unknown>>(ref: unknown, label: string, kind: string): B {
  if (ref && typeof (ref as Bundle<unknown>).resolveEntries === "function") return ref as B;
  throw new RuntimeError(
    "ERR_MCP_BUNDLE_NOT_FOUND",
    `${label}: a bundle did not resolve to a live ${kind} instance`,
  );
}

/** Refuse a matcher two bundles of one transport both declare. */
export function assertDistinctAcross(
  bundles: Bundle<unknown>[],
  code: string,
  noun: string,
): void {
  const owners = new Map<string, string>();
  for (const bundle of bundles) {
    for (const matcher of bundle.matchers) {
      const prior = owners.get(matcher);
      if (prior !== undefined) {
        throw new RuntimeError(
          `ERR_MCP_${code}_DUPLICATE`,
          `Mcp: duplicate ${noun} '${matcher}' across bundles '${prior}' and '${bundle.bundleName}'`,
        );
      }
      owners.set(matcher, bundle.bundleName);
    }
  }
}
