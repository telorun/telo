import {
  describeSelector,
  selectorFromQualifiers,
  selectorKey,
  type ArtifactSelector,
} from "@telorun/analyzer";
import { selectByPatterns } from "@telorun/glob";
import type { PayloadLayer } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import { PackageURL } from "packageurl-js";
import { parseAllDocuments } from "yaml";

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
  /** `siblings=` patterns that matched nothing, with the candidate that declared
   *  each one. */
  unmatchedSiblings: Array<{ purl: string; pattern: string }>;
}

/** `pkg:telo/local/<format>?path=…` — the bundled-controller delivery mode.
 *  Anything else (`pkg:npm`, `pkg:cargo`) fetches from its own ecosystem and
 *  contributes no layer. */
const BUNDLED_TYPE = "telo";
const BUNDLED_NAMESPACE = "local";

/** Qualifier naming extra files that belong in a controller's layer — what an
 *  entry point loads but the manifest cannot otherwise see (a `.wasm` beside its
 *  glue, a native library opened at runtime). Comma-separated
 *  `.gitignore`-style patterns, matched through the one glob engine. Optional:
 *  an unclaimed sidecar joins the common layer, which every controller-hosting
 *  kernel pulls, so omitting it costs bytes rather than a broken import. */
const SIBLINGS_QUALIFIER = "siblings";

interface ControllerClaim {
  selector: ArtifactSelector;
  /** Entry-point path exactly as `path=` names it, manifest-relative. */
  entry: string;
  /** Sibling patterns declared on the same candidate. */
  siblings: string[];
  /** For diagnostics: the PURL this claim came from. */
  purl: string;
}

/** Normalize a `path=` / sibling value to the manifest-relative POSIX form
 *  `selectFiles` returns, so membership is a string comparison. */
function normalizeRelative(value: string): string {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Every bundled-controller candidate declared anywhere in the manifest, with its
 * selector and the files it claims. Read from `controllers:` on each doc — the
 * manifest already names each entry point, so the partition is derived rather
 * than declared.
 */
export function readControllerClaims(manifestText: string): ControllerClaim[] {
  const claims: ControllerClaim[] = [];
  for (const doc of parseAllDocuments(manifestText, { customTags: defaultCustomTags() })) {
    const json = doc.toJSON() as { controllers?: unknown } | null;
    const candidates = Array.isArray(json?.controllers) ? json.controllers : [];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      let parsed: PackageURL;
      try {
        parsed = PackageURL.fromString(candidate);
      } catch {
        // Not a parseable PURL — publish is not the place to reject it; the
        // analyzer and the controller loader both report it with better context.
        continue;
      }
      if (parsed.type !== BUNDLED_TYPE || parsed.namespace !== BUNDLED_NAMESPACE) continue;
      const entry = parsed.qualifiers?.path;
      if (typeof entry !== "string" || entry === "") continue;
      const siblings = String(parsed.qualifiers?.[SIBLINGS_QUALIFIER] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
      claims.push({
        selector: selectorFromQualifiers(
          parsed.name,
          parsed.qualifiers,
          `controller "${candidate}"`,
        ),
        entry: normalizeRelative(entry),
        siblings,
        purl: candidate,
      });
    }
  }
  return claims;
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
 * `files` are the manifest-relative paths `selectFiles` produced; `assetPatterns`
 * is the author's `assets:` list. Every bundled controller's `path=` entry joins
 * the payload whether or not `files:` selected it — the manifest already names
 * it, so restating it would be pure duplication. Layers with no files are
 * dropped, so a controller-only module publishes exactly one payload layer.
 */
export function partitionLayers(
  manifestText: string,
  files: string[],
  assetPatterns: string[],
): Partition {
  const claims = readControllerClaims(manifestText);

  // A controller entry point is part of the payload because `controllers:` names
  // it, not because `files:` restates it. `files:` keeps its role for everything
  // the manifest cannot otherwise see — assets, static files, sidecars — and a
  // module whose only payload is its controller declares no `files:` at all.
  //
  // Sibling patterns are still matched against `files:` alone: a sibling is a
  // glob over the payload, so a pattern that selects nothing there means the
  // author forgot to include the file, which `unmatchedSiblings` reports.
  const selected = new Set([...files, ...claims.map((claim) => claim.entry)]);
  const unclaimed = new Set(files);

  // Controller layers first: a file an entry point or sibling claims belongs to
  // that selector, never to assets or common, so the layer a kernel skips is
  // genuinely skippable. A file several candidates claim is copied into each of
  // their layers rather than taken by whichever came first — the alternative
  // leaves the later platform's layer missing a file it declared it needs, which
  // would break the "a declaration never costs correctness" guarantee.
  const bySelector = new Map<string, LayerPlan>();
  const unmatchedSiblings: Array<{ purl: string; pattern: string }> = [];
  for (const claim of claims) {
    const key = selectorKey(claim.selector);
    let plan = bySelector.get(key);
    if (!plan) {
      plan = { role: "controller", selector: claim.selector, files: [] };
      bySelector.set(key, plan);
    }
    const siblings = selectByPatterns([...selected], claim.siblings, {
      applyDefaultIgnore: false,
    });
    for (const pattern of claim.siblings) {
      if (selectByPatterns([...selected], [pattern], { applyDefaultIgnore: false }).length === 0) {
        unmatchedSiblings.push({ purl: claim.purl, pattern });
      }
    }
    for (const file of [claim.entry, ...siblings]) {
      unclaimed.delete(file);
      if (!plan.files.includes(file)) plan.files.push(file);
    }
  }

  const assetFiles = selectByPatterns([...unclaimed], assetPatterns, {
    applyDefaultIgnore: false,
  });
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
  for (const { purl, pattern } of partition.unmatchedSiblings) {
    lines.push(`siblings pattern '${pattern}' matched no file (from ${purl})`);
  }
  return lines;
}
