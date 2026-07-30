/**
 * The **selector** of `kernel/specs/module-artifact.md` — the tuple a bundled
 * controller candidate is chosen by, and the key a controller layer of a module
 * artifact is stored under.
 *
 * A selector is `format` plus the optional platform axes `os` / `arch` / `libc`.
 * Matching is one rule, applied per axis: an axis the selector omits accepts
 * anything, an axis it states must be equal. That is what lets a `js` controller
 * be platform-neutral and a `napi` controller be pinned to one triple, with no
 * special case for either.
 *
 * Browser-safe and dependency-free by construction. Three consumers must agree
 * on this grammar or a published artifact stops loading: `telo publish`
 * (partitioning files into layers), `telo install --platform` (deciding which
 * layers to pre-fetch), and the kernel's bundle controller loader (matching a
 * candidate against the host). Keeping it here — beside the redaction path
 * parser, for the same reason — means one implementation rather than three that
 * drift.
 *
 * PURL *syntax* is deliberately not parsed here. Callers hand in the format and
 * an already-decoded qualifier map, so this module owns selector semantics while
 * the caller owns its own package-URL library. The Node vocabulary is likewise
 * not known here: `process.platform` / `process.arch` are mapped to the
 * canonical OCI/GOOS names at the kernel boundary, since these values are
 * published into OCI descriptors.
 */

/** The role a layer plays in a module artifact. `controller` layers carry a
 *  selector; `assets` and `common` are singletons and carry none. */
export type LayerRole = "controller" | "assets" | "common";

export const LAYER_ROLES: readonly LayerRole[] = ["controller", "assets", "common"];

export function isLayerRole(value: unknown): value is LayerRole {
  return typeof value === "string" && (LAYER_ROLES as readonly string[]).includes(value);
}

/** The platform axes, in canonical order. Not a closed vocabulary of *values* —
 *  new architectures appear without a Telo release — only of axis names. */
export const PLATFORM_AXES = ["os", "arch", "libc"] as const;

export type PlatformAxis = (typeof PLATFORM_AXES)[number];

export interface ArtifactSelector {
  /** Bundled controller format: the PURL name segment (`js`, `napi`, `wasm`, …). */
  format: string;
  os?: string;
  arch?: string;
  libc?: string;
}

/** What a selector is matched against: the host the kernel runs on, or the
 *  target `telo install --platform` is warming a cache for. An axis left
 *  undetermined (a host whose libc cannot be detected) matches no selector that
 *  constrains it — refusing to load is the safe direction for a native binary. */
export interface PlatformTarget {
  format?: string;
  os?: string;
  arch?: string;
  libc?: string;
}

export class ArtifactSelectorError extends Error {
  readonly code = "INVALID_ARTIFACT_SELECTOR";

  constructor(detail: string) {
    super(detail);
    this.name = "ArtifactSelectorError";
  }
}

/** Canonical token shape for every selector value. Lowercase, so the same
 *  platform written two ways is one layer rather than two. */
const TOKEN = /^[a-z0-9][a-z0-9_.-]*$/;

function normalizeToken(axis: string, raw: unknown, describe: string): string {
  if (typeof raw !== "string") {
    throw new ArtifactSelectorError(
      `${describe}: ${axis} must be a string, got ${raw === null ? "null" : typeof raw}.`,
    );
  }
  const value = raw.trim().toLowerCase();
  if (!TOKEN.test(value)) {
    throw new ArtifactSelectorError(
      `${describe}: ${axis} value '${raw}' is not a canonical token. ` +
        `Use lowercase letters, digits, '.', '-' or '_', starting with a letter or digit.`,
    );
  }
  return value;
}

/**
 * Build a selector from a controller candidate's format and qualifier map.
 * Qualifier keys other than the platform axes are ignored — `path` and the
 * sibling list live in the same map and are not part of the selector.
 */
export function selectorFromQualifiers(
  format: unknown,
  qualifiers: Readonly<Record<string, unknown>> | undefined,
  describe = "controller selector",
): ArtifactSelector {
  const selector: ArtifactSelector = {
    format: normalizeToken("format", format, describe),
  };
  for (const axis of PLATFORM_AXES) {
    const raw = qualifiers?.[axis];
    if (raw === undefined || raw === "") continue;
    selector[axis] = normalizeToken(axis, raw, describe);
  }
  return selector;
}

/** Validate and normalize a selector read off a published layer index. */
export function normalizeSelector(
  value: unknown,
  describe = "layer selector",
): ArtifactSelector {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactSelectorError(`${describe}: expected an object of selector axes.`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (k) => k !== "format" && !(PLATFORM_AXES as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    throw new ArtifactSelectorError(
      `${describe}: unknown selector ${unknown.length === 1 ? "axis" : "axes"} ` +
        `${unknown.map((k) => `'${k}'`).join(", ")}. Known axes: format, ${PLATFORM_AXES.join(", ")}.`,
    );
  }
  return selectorFromQualifiers(record.format, record, describe);
}

/**
 * The canonical stable key for a selector: sorted `axis=value` pairs joined by
 * `;`. Used to group entry points into layers at publish time and to detect two
 * layers claiming the same selector. Sorted and fully qualified so no two
 * distinct selectors can collide and no one selector has two spellings.
 */
export function selectorKey(selector: ArtifactSelector): string {
  const pairs: string[] = [`format=${selector.format}`];
  for (const axis of PLATFORM_AXES) {
    const value = selector[axis];
    if (value !== undefined) pairs.push(`${axis}=${value}`);
  }
  return pairs.sort().join(";");
}

/** Human-facing rendering for diagnostics and the publish partition printout. */
export function describeSelector(selector: ArtifactSelector): string {
  const platform = PLATFORM_AXES.map((axis) => selector[axis]).filter(
    (v): v is string => v !== undefined,
  );
  return platform.length === 0 ? selector.format : `${selector.format} (${platform.join("/")})`;
}

/**
 * The matching rule: every axis the selector states must equal the target's;
 * every axis it omits accepts anything. A target axis left undetermined matches
 * only a selector that does not constrain it — a host whose libc is unknown must
 * not be handed a `libc=gnu` binary on the assumption it will run.
 */
export function selectorMatches(selector: ArtifactSelector, target: PlatformTarget): boolean {
  if (target.format !== undefined && selector.format !== target.format) return false;
  for (const axis of PLATFORM_AXES) {
    const constraint = selector[axis];
    if (constraint === undefined) continue;
    if (target[axis] !== constraint) return false;
  }
  return true;
}
