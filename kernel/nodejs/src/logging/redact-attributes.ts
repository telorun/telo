import { parseRedactionPath, type RedactionSegment } from "@telorun/analyzer";
import type { AnyValue, ErrorValue, LogAttributes } from "@telorun/sdk";

/**
 * Path-based redaction — `kernel/specs/logging.md` §14.
 *
 * Only path-based redaction is portable across Node, Rust, and Go, so it is the
 * only form specified normatively. Paths are compiled once at configuration
 * time by the analyzer's hand-written parser (never by compiling source in the
 * host language, §14.1) and applied here by *navigating* to each path rather
 * than walking the whole value tree — which is what keeps an explicit path at
 * §14.2's 1–2% cost instead of the 25–55% an intermediate wildcard pays.
 *
 * The key is always preserved and only the value replaced. Deletion destroys
 * schema stability and hides that a field was present at all, so `remove` is
 * offered for the cases that genuinely need it but is never the default.
 */

export const DEFAULT_CENSOR = "[redacted]";

export interface RedactionPolicy {
  paths: readonly CompiledRedactionPath[];
  censor: string;
  remove: boolean;
}

export interface CompiledRedactionPath {
  /** The path as written, kept for diagnostics. */
  source: string;
  segments: readonly RedactionSegment[];
}

/** Compile a policy's paths once, at configuration time. Throws
 *  `RedactionPathError` with the offending offset, so a bad path fails the
 *  manifest rather than silently failing to redact at runtime. */
export function compileRedactionPolicy(config: {
  paths?: readonly string[];
  censor?: string;
  remove?: boolean;
}): RedactionPolicy {
  return {
    paths: (config.paths ?? []).map((source) => ({
      source,
      segments: parseRedactionPath(source),
    })),
    censor: config.censor ?? DEFAULT_CENSOR,
    remove: config.remove ?? false,
  };
}

export const EMPTY_REDACTION_POLICY: RedactionPolicy = {
  paths: [],
  censor: DEFAULT_CENSOR,
  remove: false,
};

/** Apply the policy to a record's attributes in place. The attributes have
 *  already been normalized (§6.3), so collections are bounded and no cycle can
 *  make the navigation diverge. */
export function redactAttributes(
  attributes: LogAttributes | undefined,
  policy: RedactionPolicy,
): void {
  if (!attributes || policy.paths.length === 0) return;
  for (const path of policy.paths) applyPath(attributes, path.segments, policy);
}

/** Redaction applies to the error as well as the attributes (§14). The error's
 *  own fields are structural rather than user data, so a path addresses them by
 *  their record spelling — `error.message`, `error.cause.message`. */
export function redactError(error: ErrorValue | undefined, policy: RedactionPolicy): void {
  if (!error || policy.paths.length === 0) return;
  const wrapper: LogAttributes = { error: error as unknown as AnyValue };
  for (const path of policy.paths) applyPath(wrapper, path.segments, policy);
}

function applyPath(
  root: LogAttributes,
  segments: readonly RedactionSegment[],
  policy: RedactionPolicy,
): void {
  if (segments.length === 0) return;

  let frontier: unknown[] = [root];

  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const next: unknown[] = [];
    for (const container of frontier) {
      if (segment.kind === "wildcard") {
        for (const child of childrenOf(container)) next.push(child);
      } else {
        const child = readKey(container, segment.name);
        if (child !== undefined) next.push(child);
      }
    }
    if (next.length === 0) return;
    frontier = next;
  }

  const last = segments[segments.length - 1]!;
  for (const container of frontier) {
    if (last.kind === "wildcard") {
      // Descending so that `remove: true` over an array — which splices each
      // matched index — does not shift the indices still to be visited. Without
      // this, `items[*]` with remove leaves every other element behind, which
      // for the §14 security control means a secret is only partially removed.
      // Order is irrelevant for the censor path.
      const keys = keysOf(container);
      for (let i = keys.length - 1; i >= 0; i -= 1) writeKey(container, keys[i]!, policy);
    } else {
      if (readKey(container, last.name) === undefined && !hasKey(container, last.name)) continue;
      writeKey(container, last.name, policy);
    }
  }
}

function childrenOf(container: unknown): unknown[] {
  if (Array.isArray(container)) return container;
  if (isPlainContainer(container)) return Object.values(container);
  return [];
}

function keysOf(container: unknown): (string | number)[] {
  if (Array.isArray(container)) return container.map((_item, index) => index);
  if (isPlainContainer(container)) return Object.keys(container);
  return [];
}

function readKey(container: unknown, key: string): unknown {
  if (Array.isArray(container)) {
    const index = Number(key);
    return Number.isInteger(index) ? container[index] : undefined;
  }
  if (isPlainContainer(container)) return container[key];
  return undefined;
}

function hasKey(container: unknown, key: string): boolean {
  if (Array.isArray(container)) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < container.length;
  }
  return isPlainContainer(container) && hasOwn(container, key);
}

function hasOwn(container: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(container, key);
}

function writeKey(container: unknown, key: string | number, policy: RedactionPolicy): void {
  if (Array.isArray(container)) {
    const index = typeof key === "number" ? key : Number(key);
    if (!Number.isInteger(index)) return;
    if (policy.remove) container.splice(index, 1);
    else container[index] = policy.censor;
    return;
  }
  if (!isPlainContainer(container)) return;
  const name = String(key);
  if (!hasOwn(container, name)) return;
  if (policy.remove) delete container[name];
  else container[name] = policy.censor;
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !(value instanceof Uint8Array);
}
