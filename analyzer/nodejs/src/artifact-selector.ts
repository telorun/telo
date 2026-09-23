/**
 * The **selector** of `kernel/specs/module-artifact.md` — the tuple a bundled
 * controller candidate is chosen by, and the key a controller layer of a module
 * artifact is stored under.
 *
 * A selector is `format` plus the optional platform axes, whose vocabulary is
 * data (`analyzer/artifact-axes/axes.json`, generated into `PLATFORM_AXES`).
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

import { AXIS_VALUE_FORMS, PLATFORM_AXES, type PlatformAxis } from "./artifact-axes.js";

/** The role a layer plays in a module artifact. `controller`, `library` and
 *  `native` layers carry a selector; `assets` and `common` are singletons and
 *  carry none. */
export type LayerRole = "controller" | "library" | "native" | "assets" | "common";

export const LAYER_ROLES: readonly LayerRole[] = [
  "controller",
  "library",
  "native",
  "assets",
  "common",
];

export function isLayerRole(value: unknown): value is LayerRole {
  return typeof value === "string" && (LAYER_ROLES as readonly string[]).includes(value);
}

/** The roles that hold executable code, and are therefore per format rather than
 *  singletons. A `library` layer is per selector for the same reason a
 *  `controller` layer is: a module's JS entry point and its future Rust one are
 *  different files, and a consumer resolves the one its own runtime can import.
 *  A singleton would be wrong the moment a second runtime ships. */
export const CODE_LAYER_ROLES: readonly LayerRole[] = ["controller", "library"];

/** Every role keyed by a selector, one layer per selector: the code roles, plus
 *  `native` — a platform-specific file the runtime does not import as code,
 *  declared in the module doc's `native:` block. */
const SELECTOR_LAYER_ROLES: readonly LayerRole[] = [...CODE_LAYER_ROLES, "native"];

export function roleCarriesSelector(role: LayerRole): boolean {
  return (SELECTOR_LAYER_ROLES as readonly string[]).includes(role);
}

export { PLATFORM_AXES, type PlatformAxis };

export interface ArtifactSelector extends Partial<Record<PlatformAxis, string>> {
  /** Bundled controller format: the PURL name segment (`js`, `napi`, `wasm`, …). */
  format: string;
}

/** What a selector is matched against: the host the kernel runs on, or the
 *  target `telo install` is warming a cache for. An axis left undetermined (a
 *  host whose libc cannot be detected) matches no selector that constrains it —
 *  refusing to load is the safe direction for a native binary. */
export interface PlatformTarget extends Partial<Record<PlatformAxis, string>> {
  format?: string;
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

/** Validate and normalize one selector value: the shared token grammar, plus the
 *  axis's own value form where the vocabulary declares one. */
export function normalizeAxisValue(axis: string, raw: unknown, describe: string): string {
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
  const valueForm = AXIS_VALUE_FORMS[axis as PlatformAxis];
  if (valueForm && !valueForm.pattern.test(value)) {
    throw new ArtifactSelectorError(
      `${describe}: ${axis} value '${raw}' must have the form ${valueForm.form}, ` +
        `e.g. ${valueForm.examples.map((e) => `'${e}'`).join(" or ")}.`,
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
    format: normalizeAxisValue("format", format, describe),
  };
  for (const axis of PLATFORM_AXES) {
    const raw = qualifiers?.[axis];
    if (raw === undefined || raw === "") continue;
    selector[axis] = normalizeAxisValue(axis, raw, describe);
  }
  return selector;
}

/**
 * Validate and normalize a selector read off a published layer index.
 *
 * Returns undefined when the selector carries an axis this runtime does not
 * know: the layer is for a newer runtime, and the caller skips it whole. The
 * unknown axis is never dropped — two layers differing only in it would then
 * claim one address. The known axes are still validated, since their grammar
 * does not change with the axis set.
 */
export function normalizeSelector(
  value: unknown,
  describe = "layer selector",
): ArtifactSelector | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactSelectorError(`${describe}: expected an object of selector axes.`);
  }
  const record = value as Record<string, unknown>;
  const selector = selectorFromQualifiers(record.format, record, describe);
  const carriesUnknownAxis = Object.keys(record).some(
    (k) => k !== "format" && !(PLATFORM_AXES as readonly string[]).includes(k),
  );
  return carriesUnknownAxis ? undefined : selector;
}

/**
 * The canonical stable key for a selector: sorted `axis=value` pairs joined by
 * `;`. Used to group entry points into layers at publish time and to detect two
 * layers claiming the same selector. Sorted and fully qualified so no two
 * distinct selectors can collide and no one selector has two spellings.
 */
export function selectorKey(selector: ArtifactSelector): string {
  // A layer lookup keys every layer of an artifact on each resolution; a
  // selector is complete once built, so its key is computed once.
  let key = selectorKeys.get(selector);
  if (key === undefined) {
    const pairs: string[] = [`format=${selector.format}`];
    for (const axis of PLATFORM_AXES) {
      const value = selector[axis];
      if (value !== undefined) pairs.push(`${axis}=${value}`);
    }
    key = pairs.sort().join(";");
    selectorKeys.set(selector, key);
  }
  return key;
}

const selectorKeys = new WeakMap<ArtifactSelector, string>();

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

/**
 * The axes `selector` constrains and `target` leaves undetermined, when those
 * alone keep the two from matching — what a warm skips for want of a value rather
 * than because the selector is for another platform. `undefined` when the
 * selector matches, or differs on a determined axis.
 */
export function undeterminedAxesBlockingMatch(
  selector: ArtifactSelector,
  target: PlatformTarget,
): PlatformAxis[] | undefined {
  if (target.format !== undefined && selector.format !== target.format) return undefined;
  const axes: PlatformAxis[] = [];
  for (const axis of PLATFORM_AXES) {
    const constraint = selector[axis];
    if (constraint === undefined) continue;
    if (target[axis] === undefined) axes.push(axis);
    else if (target[axis] !== constraint) return undefined;
  }
  return axes.length > 0 ? axes : undefined;
}

/** A selector that no host can match as its author meant it. */
export interface SelectorContradiction {
  /** Suffix of the diagnostic code; each surface prefixes its own. */
  readonly rule: "NAPI_ABI_FORBIDDEN" | "LIBC_OFF_LINUX";
  readonly axis: PlatformAxis;
  readonly detail: string;
}

/**
 * The combinations of axes the grammar accepts and no host can mean: an N-API
 * addon stating a runtime ABI, and a libc on an os that has none. Shared by every
 * surface that authors a selector — `native:` entries, controller candidates and
 * `exports.code:` entries — so each reports the same rule under its own prefix.
 */
export function selectorContradictions(selector: ArtifactSelector): SelectorContradiction[] {
  const out: SelectorContradiction[] = [];
  if (selector.format === "napi" && selector.abi !== undefined) {
    out.push({
      rule: "NAPI_ABI_FORBIDDEN",
      axis: "abi",
      detail:
        `an N-API addon is ABI-stable across runtime releases and states no abi — remove ` +
        `abi ${selector.abi}, which would keep it from loading anywhere else.`,
    });
  }
  if (selector.libc !== undefined && selector.os !== undefined && selector.os !== "linux") {
    out.push({
      rule: "LIBC_OFF_LINUX",
      axis: "libc",
      detail:
        `libc is only determined on linux, so a selector for os '${selector.os}' that states ` +
        `libc ${selector.libc} could never match a host. Remove libc.`,
    });
  }
  return out;
}
