// The packages a GitHub Release names: what the changesets action reported as published,
// joined — in a final or patch, whose CLI moved — with the version bumps of the release commit.
//
// A re-run of a release job whose first attempt published most of the packages publishes only
// the rest, so the action reports a partial set. Taken alone it names no CLI, and the cycle
// would be released package by package instead of as `v<cli version>`.

/**
 * `published` (the action's set) and `recovered` (the version bumps of the release commit),
 * as `{ name, version }` lists: the action's set alone for a candidate or a packages-only
 * release, its union with `recovered` (the action's entry winning) for a final or patch —
 * and `recovered` when the action reported nothing.
 */
export function candidatePackages({ published, recovered, channel }) {
  if (published.length === 0) return recovered;
  if (!channel || !["final", "patch"].includes(channel)) return published;
  const named = new Set(published.map((pkg) => pkg.name));
  return [...published, ...recovered.filter((pkg) => !named.has(pkg.name))];
}
