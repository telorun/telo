import {
  needFeatures,
  needVersionRange,
  parseModuleVersion,
  rangeAccepts,
  type NeedConstraint,
  type NeedTableEntry,
  type ReachSite,
} from "@telorun/analyzer";
import type { NeedConstraints, NeedObservation } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

/**
 * The kernel half of `Need.Resolve` / `Need.Verify` that reads no context: where
 * a JSON Pointer names a reference slot, which slots observe, and the
 * comparison of an observation against the outermost need. No controller
 * compares a range — this is the one place a need's constraints are decided.
 */

/** The JSON Pointer of a reach site. */
export function pointerOf(keys: readonly (string | number)[]): string {
  return keys.map((k) => `/${String(k).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/** The reference site `pointer` names, or undefined. */
export function referenceSiteAt(sites: readonly ReachSite[], pointer: string): ReachSite | undefined {
  return sites.find((site) => site.refs.length > 0 && pointerOf(site.keys) === pointer);
}

/** The constraints the slot at `site` observes. */
export function observedAt(site: ReachSite): NeedConstraint[] {
  const out = new Set<NeedConstraint>();
  for (const ref of site.refs) for (const c of ref.slot.observes ?? []) out.add(c);
  return [...out];
}

function isReference(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).name === "string"
  );
}

/** Every concrete pointer at an observing slot that holds a reference — what
 *  a resource owes an observation for, by its deadline. */
export function observingPointers(
  sites: readonly ReachSite[],
): Map<string, readonly NeedConstraint[]> {
  const out = new Map<string, readonly NeedConstraint[]>();
  for (const site of sites) {
    if (site.refs.length === 0) continue;
    const observes = observedAt(site);
    if (observes.length === 0 || !isReference(site.data)) continue;
    out.set(pointerOf(site.keys), observes);
  }
  return out;
}

/** The constraints an entry's need states, in the form a controller reads. */
export function constraintsOf(entry: NeedTableEntry | undefined): NeedConstraints {
  if (!entry) return {};
  const range = needVersionRange(entry.need);
  const features = needFeatures(entry.need);
  return {
    ...(range ? { version: range.raw } : {}),
    ...(features.length > 0 ? { features } : {}),
  };
}

/** Refuse an observation that is not one: a member for a constraint the slot
 *  does not observe, an observed one missing, a version that is not semver,
 *  features that are not names. */
export function checkObservation(
  label: string,
  pointer: string,
  observes: readonly NeedConstraint[],
  observation: unknown,
): NeedObservation {
  const refuse = (why: string): never => {
    throw new RuntimeError(
      "ERR_NEED_OBSERVATION_INVALID",
      `${label}: the observation reported for '${pointer}' ${why}.`,
    );
  };
  if (observes.length === 0) {
    refuse(
      `is at a slot that observes nothing — its kind's x-telo-ref declares no 'observes', so the ` +
        `kernel has no constraint to compare it with`,
    );
  }
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    refuse(`is not an object of ${observes.join(" / ")}`);
  }
  const record = observation as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(observes as readonly string[]).includes(key)) {
      refuse(`reports '${key}', which the slot does not observe (it observes ${observes.join(", ")})`);
    }
  }
  if (observes.includes("version")) {
    const version = record.version;
    if (typeof version !== "string") refuse(`carries no 'version'`);
    if (!parseModuleVersion(version as string)) {
      refuse(`reports version ${JSON.stringify(version)}, which is not semver (X.Y.Z, optionally -prerelease)`);
    }
  }
  if (observes.includes("features")) {
    const features = record.features;
    if (!Array.isArray(features) || features.some((f) => typeof f !== "string")) {
      refuse(`carries no 'features' list of names`);
    }
  }
  return record as NeedObservation;
}

/** Where the outermost need's value came from, for a refusal. */
function sourceOf(entry: NeedTableEntry): { source: "env" | "declaration"; text: string } {
  if (entry.supply === "environment") {
    const names = Object.values(entry.fields ?? {}).map((field) => field.env);
    return { source: "env", text: `the environment (${names.join(", ")})` };
  }
  return { source: "declaration", text: entry.suppliedBy ?? "a declaration" };
}

/**
 * Compare an observation with the outermost need of the whole-forward chain and
 * refuse a mismatch with `ERR_NEED_UNMET`, its `data` holding `need`, `type`,
 * `source`, `required` and `actual`. Observed features the type does not list
 * are ignored.
 */
export function compareObservation(
  outermost: NeedTableEntry | undefined,
  type: string,
  typeFeatures: readonly string[],
  observation: NeedObservation,
): void {
  if (!outermost) return;
  const range = needVersionRange(outermost.need);
  const wanted = needFeatures(outermost.need);
  const actualFeatures = (observation.features ?? []).filter((f) => typeFeatures.includes(f));
  const versionFails =
    range !== undefined && observation.version !== undefined && !rangeAccepts(range, observation.version);
  const missing =
    observation.features !== undefined ? wanted.filter((f) => !actualFeatures.includes(f)) : [];
  if (!versionFails && missing.length === 0) return;
  const path = outermost.path.join(".");
  const { source, text } = sourceOf(outermost);
  const required: NeedConstraints = {
    ...(versionFails ? { version: range!.raw } : {}),
    ...(missing.length > 0 ? { features: wanted } : {}),
  };
  const actual: NeedObservation = {
    ...(versionFails ? { version: observation.version } : {}),
    ...(missing.length > 0 ? { features: actualFeatures } : {}),
  };
  const what = [
    versionFails ? `version ${observation.version}, outside '${range!.raw}'` : undefined,
    missing.length > 0 ? `no ${missing.map((f) => `'${f}'`).join(", ")} among its features` : undefined,
  ]
    .filter(Boolean)
    .join(", and ");
  const error = new RuntimeError(
    "ERR_NEED_UNMET",
    `Need '${path}' (type '${type}') is not met: the fulfilment supplied from ${text} has ${what}.`,
  );
  Object.assign(error, { data: { need: path, type, source, required, actual } });
  throw error;
}
