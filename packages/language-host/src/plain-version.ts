import type { VersionBound, VersionInterval } from "@telorun/editor-protocol";

const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const IDENTITY = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `major.minor.patch` with nothing else — the only versions the registry
 *  offers and the only form an interval edge is compared in. `undefined` for
 *  anything else, so a caller can never order a version it could not read. */
export function parsePlainVersion(version: string): [number, number, number] | undefined {
  const match = PLAIN.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * An engine identity (`@telorun/editor-protocol` § Handshake): a plain version,
 * optionally with build metadata — `0.102.0+unreleased` for a build made while
 * 0.102.0 is still pending. Its precedence is the plain version's; the build
 * metadata only tells it apart. `undefined` for anything else.
 */
export function parseEngineIdentity(identity: string): { precedence: [number, number, number]; build?: string } | undefined {
  const match = IDENTITY.exec(identity);
  if (!match) return undefined;
  return { precedence: parsePlainVersion(match[1]!)!, ...(match[2] ? { build: match[2].slice(1) } : {}) };
}

/** Semver precedence of two engine identities — build metadata ignored, so
 *  `0.102.0` and `0.102.0+unreleased` tie. Throws on anything that is not an
 *  identity: the host never compares anything else, so reaching one is a
 *  defect, not a tie. */
export function comparePlainVersions(a: string, b: string): number {
  const left = parseEngineIdentity(a)?.precedence;
  const right = parseEngineIdentity(b)?.precedence;
  if (!left || !right) {
    throw new Error(`cannot order '${a}' and '${b}': both must be major.minor.patch versions, optionally with +build metadata.`);
  }
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function above(version: string, bound: VersionBound): boolean {
  const order = comparePlainVersions(version, bound.version);
  return bound.inclusive ? order >= 0 : order > 0;
}

function below(version: string, bound: VersionBound): boolean {
  const order = comparePlainVersions(version, bound.version);
  return bound.inclusive ? order <= 0 : order < 0;
}

/** Whether an interval the engine normalized admits the engine identity
 *  `version`, by precedence. An edge the host cannot read as a plain version
 *  admits nothing: a range naming a prerelease edge is not something to guess
 *  an order for. */
export function intervalAccepts(interval: VersionInterval, version: string): boolean {
  for (const edge of [interval.min, interval.max]) {
    if (edge && !parsePlainVersion(edge.version)) return false;
  }
  return (!interval.min || above(version, interval.min)) && (!interval.max || below(version, interval.max));
}
