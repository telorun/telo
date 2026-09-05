/**
 * What changed between two loads of one manifest set.
 *
 * The question a reconciling host asks before it touches anything: which
 * resources survive an edit untouched, which have to be rebuilt, which are new,
 * and which are gone. It is here rather than in the kernel because it is pure
 * data in and data out and the editor wants the same answer — to show which
 * resources a save would restart, in a browser, where no kernel runs.
 *
 * **This is the DECLARATION half of the question and only that half.** A field
 * written `!cel "variables.port"` has the same declaration whatever the
 * environment says, so a host that resolves configuration outside the manifest
 * has to supply what moved there (`modulesWithChangedConfig`). Keeping the two
 * apart is what lets this run in a browser at all.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { nodeIdFor } from "./call-graph.js";
import { canonicalJson } from "./canonical-json.js";
import { DERIVED_METADATA_FIELDS } from "./module-metadata-scope.js";

/** How one resource differs between the two sets. `unchanged` is reported as a
 *  bare id rather than an entry, since there is nothing to say about it. */
export type ResourceChangeKind = "added" | "removed" | "changed";

export interface DiffEntry {
  /** {@link nodeIdFor} — module-scoped, so two libraries each declaring a
   *  resource named `store` are two entries rather than one. */
  readonly id: string;
  readonly change: ResourceChangeKind;
  /** The declaration as it stood. Absent for an addition. */
  readonly previous?: ResourceManifest;
  /** The declaration as it now stands. Absent for a removal. */
  readonly next?: ResourceManifest;
}

export interface ManifestDiff {
  /** Additions, removals and changes. Order follows the next set, then the
   *  previous set for removals, so a caller rendering this reads it in
   *  declaration order rather than in hash order. */
  readonly entries: readonly DiffEntry[];
  /** Ids present in both sets with an identical declaration. */
  readonly unchanged: readonly string[];
  /** Ids whose current instance is no longer valid: every removal and every
   *  change. What a reconciling host unwinds, once it has closed this set under
   *  the resources that HOLD them — which is the call graph's answer, not this
   *  one's. */
  readonly stale: readonly string[];
  /** Declarations that have to be created: every addition and every change.
   *  Named for the kernel's own `pendingResources`, which is where they go. */
  readonly pending: readonly ResourceManifest[];
}

export interface ManifestDiffOptions {
  /**
   * Modules whose resolved configuration moved between the two loads, by
   * `metadata.module`.
   *
   * Every resource of such a module is reported `changed` even where its
   * declaration is identical, because a declaration is not the whole of what a
   * resource is built from: `!cel "variables.port"` reads the same and means
   * something else once the environment behind it moves. Only the host that
   * resolved that environment can know, so it is an input rather than something
   * derived here.
   */
  readonly modulesWithChangedConfig?: ReadonlySet<string>;

  /**
   * Signatures of the previous set, by node id, taken while those manifests
   * were still declarations.
   *
   * A host that INSTALLS manifests does not keep declarations: the kernel
   * registers the very objects it loaded, and resolving references writes live
   * instances into them — a boot target's `!ref`, or a slot nested past the
   * create-time shallow copy. Signing such an object afterwards renders those
   * slots opaque and reports a change that never happened, which on a module
   * document means escalating every reconciliation there is.
   *
   * An id absent from the map is signed from its manifest, so a caller that
   * really is holding declarations passes nothing.
   */
  readonly previousSignatures?: ReadonlyMap<string, string>;
}

/** A value that is not part of the declaration and must not be walked into:
 *  a live instance a host injected over a reference slot, a function, a class
 *  instance of any kind. Rendering one as a constant keeps the walk finite and
 *  acyclic; comparing two sets across the injection boundary is not supported
 *  and is what {@link declarationSignature} documents against. */
const OPAQUE = '"\\u0000opaque"';

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * A resource's declaration, rendered so that two equal declarations render
 * identically.
 *
 * Three things are normalized away, and each would otherwise report a change
 * that is not one:
 *
 *  - **Loader stamps** (`DERIVED_METADATA_FIELDS`). `metadata.sourceLine` is the
 *    load-bearing one: inserting a line anywhere in a file shifts it for every
 *    resource below, so leaving it in would mark a whole file changed on any
 *    edit and defeat the mechanism entirely.
 *  - **A compiled expression** renders as its source text. What the author wrote
 *    is the declaration; what it evaluates to depends on configuration, which
 *    `modulesWithChangedConfig` carries instead.
 *  - **Anything that is not plain data** renders as a constant. A host that has
 *    injected live instances over its reference slots has manifests that are no
 *    longer declarations, and walking one reaches a controller's object graph,
 *    which is cyclic. Both sides must be declarations as loaded.
 *
 * The result is compared as a string rather than hashed: there is no collision
 * to reason about, and a missed change here is a resource that silently keeps
 * running against a declaration it no longer matches.
 */
export function declarationSignature(manifest: ResourceManifest): string {
  const seen = new WeakSet<object>();

  const render = (value: unknown): unknown => {
    if (isCompiledValue(value)) {
      const source = (value as { source?: unknown }).source;
      return { "\u0000cel": typeof source === "string" ? source : null };
    }
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "\u0000cycle";
    if (Array.isArray(value)) {
      seen.add(value);
      return value.map(render);
    }
    if (!isPlainObject(value)) return OPAQUE;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = render(entry);
    }
    return out;
  };

  const authoredMetadata: Record<string, unknown> = {};
  const metadata = manifest.metadata as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (DERIVED_METADATA_FIELDS.has(key)) continue;
    authoredMetadata[key] = render(value);
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest as Record<string, unknown>)) {
    if (key === "metadata") continue;
    body[key] = render(value);
  }

  return canonicalJson({ ...body, metadata: authoredMetadata });
}

/**
 * Classify every resource of two loads against each other.
 *
 * **Identity is `nodeIdFor`**, which is module-scoped, so a name is compared
 * only against the same name in the same module. One consequence is worth
 * stating because it is visible: an INLINE resource's name is synthesized from
 * its position (`api_routes_0_handler`), so inserting a route above one renames
 * every inline below it and this reports those as a removal plus an addition.
 * That costs a restart it did not have to cost; it never misses a change, which
 * is the direction that matters.
 */
export function diffManifests(
  previous: readonly ResourceManifest[],
  next: readonly ResourceManifest[],
  options: ManifestDiffOptions = {},
): ManifestDiff {
  const before = new Map<string, ResourceManifest>();
  for (const manifest of previous) before.set(nodeIdFor(manifest), manifest);

  const changedConfig = options.modulesWithChangedConfig;
  const configMoved = (manifest: ResourceManifest): boolean => {
    if (!changedConfig || changedConfig.size === 0) return false;
    const module = (manifest.metadata as { module?: string } | undefined)?.module;
    return module !== undefined && changedConfig.has(module);
  };

  const entries: DiffEntry[] = [];
  const unchanged: string[] = [];
  const stale: string[] = [];
  const pending: ResourceManifest[] = [];
  const survived = new Set<string>();

  for (const manifest of next) {
    const id = nodeIdFor(manifest);
    const prior = before.get(id);
    if (!prior) {
      entries.push({ id, change: "added", next: manifest });
      pending.push(manifest);
      continue;
    }
    survived.add(id);
    const priorSignature =
      options.previousSignatures?.get(id) ?? declarationSignature(prior);
    const same = !configMoved(manifest) && priorSignature === declarationSignature(manifest);
    if (same) {
      unchanged.push(id);
      continue;
    }
    entries.push({ id, change: "changed", previous: prior, next: manifest });
    stale.push(id);
    pending.push(manifest);
  }

  for (const [id, manifest] of before) {
    if (survived.has(id)) continue;
    entries.push({ id, change: "removed", previous: manifest });
    stale.push(id);
  }

  return { entries, unchanged, stale, pending };
}
