import {
  describeSelector,
  selectorKey,
  type ArtifactSelector,
  type ModuleFileClaim,
} from "@telorun/analyzer";
import { selectByPatterns } from "@telorun/glob";
import type { PayloadLayer } from "@telorun/kernel";

/** Manifest-relative POSIX path of a selected file, grouped into the layer it
 *  belongs to. Content is read by the caller — this module decides membership
 *  only, so it stays testable without a filesystem. */
export interface LayerPlan {
  role: PayloadLayer["role"];
  selector?: ArtifactSelector;
  files: string[];
}

/** Where every selected file landed, for the publish-time printout. The author's
 *  only feedback that a file they meant as a controller sidecar ended up in the
 *  common layer, or that an asset they forgot to claim is not lazy. */
export interface Partition {
  layers: LayerPlan[];
  /** `assets:` patterns that matched nothing — almost always a typo, and invisible
   *  in `layers` because an empty layer is dropped. */
  unmatchedAssets: string[];
  /** `siblings=` patterns that matched nothing, with the claim that declared
   *  each one. */
  unmatchedSiblings: Array<{ origin: string; pattern: string }>;
}

/**
 * Partition the selected payload into the layers a module artifact ships.
 *
 * A **controller layer** per distinct selector, holding its entry points plus
 * whatever their sibling qualifiers claim. The **assets** layer holds what
 * `assets:` claims — it is fetched lazily, on first module-relative access. The
 * **common** layer holds everything left over.
 *
 * The sink runs toward correctness: an unclaimed file joins `common`, which is
 * materialized alongside *any* controller layer, so a sidecar nobody declared is
 * on disk before the controller that needs it imports. A forgotten declaration
 * therefore costs bytes, never a module-not-found at runtime. Both declarations
 * are optional and only ever buy laziness.
 *
 * `claims` is everything the manifest names — read by `collectModuleFileClaims`,
 * which asks each syntax's own owner (this module recognises neither a PURL nor
 * a YAML tag). `files` are the manifest-relative paths `selectFiles` produced;
 * `assetPatterns` is the author's `assets:` list. A claimed file joins the
 * payload whether or not `files:` selected it — the manifest already names it,
 * so restating it would be pure duplication. Layers with no files are dropped,
 * so a controller-only module publishes exactly one payload layer.
 */
export function partitionLayers(
  claims: readonly ModuleFileClaim[],
  files: string[],
  assetPatterns: string[],
): Partition {
  // Narrowing predicates, so the controller branch reaches `selector` and
  // `siblings` as declared fields rather than through a non-null assertion —
  // the claim type is a discriminated union precisely so this is checked.
  const controllers = claims.filter(
    (claim): claim is Extract<ModuleFileClaim, { role: "controller" }> =>
      claim.role === "controller",
  );
  const libraries = claims.filter(
    (claim): claim is Extract<ModuleFileClaim, { role: "library" }> => claim.role === "library",
  );
  const claimedAssets = claims.filter((claim) => claim.role === "assets");
  /** Library entry points, by path: a file claimed as both a controller entry and
   *  a library entry belongs to the LIBRARY layer. That is the weaker
   *  precondition — a consumer resolving this module's specifier must reach the
   *  file without loading this module's controllers — and a module whose
   *  controllers are selected out of its one bundle is exactly that case. */
  const libraryFiles = new Set(libraries.map((claim) => claim.path));

  // A claimed file is part of the payload because the manifest names it, not
  // because `files:` restates it. `files:` keeps its role for everything the
  // manifest cannot otherwise see — static files, sidecars — and a module whose
  // only payload is its controller declares no `files:` at all.
  //
  // Sibling patterns are still matched against `files:` alone: a sibling is a
  // glob over the payload, so a pattern that selects nothing there means the
  // author forgot to include the file, which `unmatchedSiblings` reports.
  const selected = new Set([...files, ...claims.map((claim) => claim.path)]);
  const unclaimed = new Set([...files, ...claimedAssets.map((claim) => claim.path)]);

  // Controller layers first: a file an entry point or sibling claims belongs to
  // that selector, never to assets or common, so the layer a kernel skips is
  // genuinely skippable. A file several candidates claim is copied into each of
  // their layers rather than taken by whichever came first — the alternative
  // leaves the later platform's layer missing a file it declared it needs, which
  // would break the "a declaration never costs correctness" guarantee.
  const bySelector = new Map<string, LayerPlan>();
  const unmatchedSiblings: Array<{ origin: string; pattern: string }> = [];

  // Library layers first, so a dual-claimed entry point is already spoken for
  // when the controller pass runs and is not copied into both.
  for (const claim of libraries) {
    const key = `library\0${selectorKey(claim.selector)}`;
    let plan = bySelector.get(key);
    if (!plan) {
      plan = { role: "library", selector: claim.selector, files: [] };
      bySelector.set(key, plan);
    }
    unclaimed.delete(claim.path);
    if (!plan.files.includes(claim.path)) plan.files.push(claim.path);
  }

  for (const claim of controllers) {
    const key = `controller\0${selectorKey(claim.selector)}`;
    let plan = bySelector.get(key);
    if (!plan) {
      plan = { role: "controller", selector: claim.selector, files: [] };
      bySelector.set(key, plan);
    }
    const patterns = [...claim.siblings];
    const siblings = selectByPatterns([...selected], patterns, { applyDefaultIgnore: false });
    for (const pattern of patterns) {
      if (selectByPatterns([...selected], [pattern], { applyDefaultIgnore: false }).length === 0) {
        unmatchedSiblings.push({ origin: claim.origin, pattern });
      }
    }
    for (const file of [claim.path, ...siblings]) {
      unclaimed.delete(file);
      // A controller entry point that is also this module's library entry point
      // ships once, in the library layer; the controller layer would be a second
      // copy of the same bytes under a different digest.
      if (libraryFiles.has(file)) continue;
      if (!plan.files.includes(file)) plan.files.push(file);
    }
  }

  // A file a tag embeds is an asset by declaration, so it needs no `assets:`
  // pattern to be lazy — the manifest already said what it is. A pattern can
  // still claim more, and a file claimed both ways is one file.
  const assetFiles = [
    ...new Set([
      ...claimedAssets.map((claim) => claim.path).filter((file) => unclaimed.has(file)),
      ...selectByPatterns([...unclaimed], assetPatterns, { applyDefaultIgnore: false }),
    ]),
  ].sort();
  for (const file of assetFiles) unclaimed.delete(file);
  const unmatchedAssets = assetPatterns.filter(
    (pattern) =>
      !pattern.startsWith("!") &&
      selectByPatterns([...selected], [pattern], { applyDefaultIgnore: false }).length === 0,
  );

  const layers: LayerPlan[] = [
    ...[...bySelector.values()].map((plan) => ({ ...plan, files: plan.files.sort() })),
    { role: "assets" as const, files: assetFiles },
    { role: "common" as const, files: [...unclaimed].sort() },
  ];

  return {
    layers: layers.filter((l) => l.files.length > 0),
    unmatchedAssets,
    unmatchedSiblings,
  };
}

/**
 * One line per layer for the publish output, so an author can see that a file they
 * meant as a sidecar or an asset landed in `common` instead.
 *
 * Patterns that matched nothing are reported too: an empty layer is dropped from
 * the partition, so a typo'd `assets:` glob would otherwise print nothing at all —
 * silence about the single mistake this output exists to catch.
 */
export function describePartition(partition: Partition): string[] {
  const lines = partition.layers.map((layer) => {
    const label = layer.selector ? `${layer.role} ${describeSelector(layer.selector)}` : layer.role;
    return `${label}: ${layer.files.length} file(s)`;
  });
  for (const pattern of partition.unmatchedAssets) {
    lines.push(`assets pattern '${pattern}' matched no file`);
  }
  for (const { origin, pattern } of partition.unmatchedSiblings) {
    lines.push(`siblings pattern '${pattern}' matched no file (from ${origin})`);
  }
  return lines;
}
