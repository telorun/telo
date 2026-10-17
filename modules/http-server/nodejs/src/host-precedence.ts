import { describeHostnameMatcher, hostnameClaim, sameHostnameMatcher, type HostnameMatcher } from "@telorun/http-dispatch";
import { RuntimeError } from "@telorun/sdk";

/**
 * Which mounts a request's host reaches, class by class: the mounts naming the
 * host exactly, then each pattern naming it (the longest literal suffix first),
 * then the mounts answering every host — the unrestricted ones, and a
 * `customDomains` mount when no entry of the server claims the host. The first
 * class holding a route for the request's method and path answers it.
 */
export interface MountHostEntry {
  /** The constraint value the mount's routes register under — never a hostname. */
  id: string;
  /** How the mount is named in a message. */
  label: string;
  matchers: readonly HostnameMatcher[];
  /** Whether the mount names `hostnames`. */
  restricted: boolean;
  /** Whether a `hostnames` entry takes custom domains. */
  customDomains: boolean;
}

/** The derived constraint value: the mounts of one precedence class. */
export class HostClass {
  constructor(readonly ids: ReadonlySet<string>) {}
}

export const NO_CLASS = new HostClass(new Set());

/** The precedence classes `host` reaches, in order, each a set of mount ids. */
export function hostClasses(entries: readonly MountHostEntry[], host: string): HostClass[] {
  const exact = new Set<string>();
  const patterns = new Map<string, { strength: number; ids: Set<string> }>();
  let claimed = false;
  for (const entry of entries) {
    let best: { strength: number; matcher: HostnameMatcher } | undefined;
    for (const matcher of entry.matchers) {
      const strength = hostnameClaim(matcher, host);
      if (strength !== undefined && (!best || strength > best.strength)) best = { strength, matcher };
    }
    if (!best) continue;
    claimed = true;
    if (best.strength === Number.POSITIVE_INFINITY) {
      exact.add(entry.id);
      continue;
    }
    const key = describeHostnameMatcher(best.matcher);
    const group = patterns.get(key) ?? { strength: best.strength, ids: new Set<string>() };
    group.ids.add(entry.id);
    patterns.set(key, group);
  }
  const open = new Set(
    entries
      .filter((entry) => !entry.restricted || (entry.customDomains && !claimed))
      .map((entry) => entry.id),
  );
  const classes: HostClass[] = [];
  if (exact.size > 0) classes.push(new HostClass(exact));
  for (const group of [...patterns.values()].sort((a, b) => b.strength - a.strength)) {
    classes.push(new HostClass(group.ids));
  }
  if (open.size > 0) classes.push(new HostClass(open));
  return classes;
}

/** Whether two mounts can share a precedence class for some host. */
function shareAClass(a: MountHostEntry, b: MountHostEntry): string | undefined {
  const openA = !a.restricted || a.customDomains;
  const openB = !b.restricted || b.customDomains;
  if (openA && openB) return "every host no entry claims";
  for (const left of a.matchers) {
    const shared = b.matchers.find((right) => sameHostnameMatcher(left, right));
    if (shared) return `host '${describeHostnameMatcher(shared)}'`;
  }
  return undefined;
}

/** Refuse a route `entry` registers that a mount of the same class already has. */
export function refuseDuplicateRoute(
  server: string,
  method: string,
  path: string,
  entry: MountHostEntry,
  others: readonly MountHostEntry[],
): void {
  for (const other of others) {
    if (other.id === entry.id) continue;
    const where = shareAClass(entry, other);
    if (where === undefined) continue;
    throw new RuntimeError(
      "ERR_HTTP_ROUTE_DUPLICATE",
      `Http.Server[${server}]: ${other.label} and ${entry.label} both register ${method} ${path} ` +
        `for ${where}. A host reaches one route per method and path.`,
    );
  }
}
