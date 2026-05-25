/** Resource-kind sets used by analysis passes to decide what counts as a
 *  user-defined instance vs. a system-level blueprint. Pulled into one
 *  place so the three passes (reference validation, dependency graph,
 *  ref-sentinel resolution) don't drift; each pass exports its own
 *  scoped view with a comment explaining what's in and what's out. */

/** Skipped by reference validation: type blueprints whose own ref slots
 *  belong to a different phase (definition schema validation rather than
 *  per-resource validation). Telo.Application and Telo.Library
 *  intentionally fall through — Application has `targets` (real refs) and
 *  Library is harmless (no ref-bearing fields). Telo.Import is also
 *  intentionally not skipped — its `source` is not an x-telo-ref slot, so
 *  walking it is cheap and consistent. */
export const REF_VALIDATION_SKIP_KINDS: ReadonlySet<string> = new Set([
  "Telo.Definition",
  "Telo.Abstract",
]);

/** Excluded from the dependency graph: kinds that are not runtime nodes.
 *  Telo.Abstract is intentionally not in this set today — abstracts have
 *  no resource manifests, so they never reach graph construction; if
 *  that ever changes, add it explicitly. */
export const DEPENDENCY_GRAPH_SKIP_KINDS: ReadonlySet<string> = new Set([
  "Telo.Definition",
  "Telo.Import",
]);

/** Skipped by `!ref` sentinel resolution: kinds whose bodies are
 *  blueprints or import-time metadata, not resource instances with
 *  user-referenced ref slots. Mirrors `REF_VALIDATION_SKIP_KINDS` but
 *  also drops Telo.Import (its `source` isn't a ref slot, and walking
 *  the field map on it is pointless since there's no registered kind). */
export const REF_RESOLUTION_SKIP_KINDS: ReadonlySet<string> = new Set([
  "Telo.Definition",
  "Telo.Abstract",
  "Telo.Import",
]);
