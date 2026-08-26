import type { ResourceManifest } from "@telorun/sdk";

/**
 * The `resources:` block on a `Telo.Library` — the instances a library requires
 * from whoever imports it, beside the scalar `variables:` / `secrets:` blocks.
 * Instances used to flow up only (`exports.resources`); this is the inward half.
 *
 * THE SINGLE READER of the block, in both halves (the analyzer's passes and the
 * kernel's import controller), on the `ref-slot.ts` precedent: a boundary whose
 * shape two runtimes must agree about is read in one place, so the next shape
 * change is a one-file edit rather than four surfaces recognising a block by
 * pattern-matching it.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

/** One declared input. */
export interface ResourceInput {
  /** The entry key. Inside the library the instance is named exactly as a
   *  locally declared resource: `!ref <name>` at a ref slot, `resources.<name>`
   *  in CEL. */
  name: string;
  /** The alias-qualified kind constraint, as written in the DECLARING library's
   *  own scope (`Sql.Connection`, `Self.Store`, `Telo.LogSink`). There is no
   *  `use:` here: the boundary is a dependency edge for init order whatever the
   *  library does with the instance, and the flattened application analysis
   *  drops the library doc, so an app-level claim about internal call sites is
   *  one nothing could check. */
  kind: string;
  description?: string;
}

/** Marker stamped on a synthesized kind-only declaration (see
 *  {@link injectedDeclarations}). Read through {@link isInjectedDeclaration} —
 *  never by testing the field. */
const INJECTED = "xTeloInjected";

/** Read a module document's `resources:` block. Returns `[]` for an
 *  `Telo.Application` (which has no such block), for a library that declares
 *  none, and for a malformed entry — the document's own schema validation
 *  reports the shape against the precise `resources.<name>` path. */
export function readResourceInputs(moduleDoc: unknown): ResourceInput[] {
  const raw = (moduleDoc as { resources?: unknown } | undefined)?.resources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: ResourceInput[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind !== "string" || kind.length === 0) continue;
    const description = (value as { description?: unknown }).description;
    out.push({
      name,
      kind,
      ...(typeof description === "string" ? { description } : {}),
    });
  }
  return out;
}

/** The values an import supplies for a target library's declared inputs, keyed
 *  by entry name. Read off a `Telo.Import` (authored or desugared from an
 *  `imports:` entry). Values are `!ref` sentinels before Phase 2.5 and
 *  `{kind, name}` after it — this reader does not interpret them. */
export function readSuppliedResources(importDoc: unknown): Record<string, unknown> {
  const raw = (importDoc as { resources?: unknown } | undefined)?.resources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/** True when `manifest` is a synthesized kind-only declaration standing in for a
 *  library's `resources:` entry rather than a resource the author declared. */
export function isInjectedDeclaration(manifest: ResourceManifest | undefined): boolean {
  return (manifest?.metadata as Record<string, unknown> | undefined)?.[INJECTED] === true;
}

/**
 * Synthesize a kind-only declaration per `resources:` entry, in the declaring
 * library's own scope.
 *
 * That model has to exist because a library's internals are validated in the
 * library's own pass — the flattened application analysis drops the library doc
 * — so with nothing behind `connection`, `!ref connection` would have nothing to
 * resolve against.
 *
 * Kind-only is enough because it is already what a ref slot gets: a reading
 * types its `status:` half from the kind, closed so a typo below it is
 * `CEL_UNKNOWN_FIELD`, and leaves the flat half open, since no manifest declares
 * what `snapshot()` returned. So `!ref connection` at a ref slot and
 * `resources.connection.<field>` in CEL answer exactly as they do for a locally
 * declared resource.
 *
 * The declaration is a stand-in, never an instantiation: the per-resource
 * validation loop skips it (its kind is routinely an abstract, and its config is
 * the importer's to supply), and the kernel's import controller filters it out
 * of the manifests it registers, binding the borrowed instance under the name
 * instead.
 */
export function injectedDeclarations(
  moduleDoc: ResourceManifest,
  ownModule: string | undefined,
): ResourceManifest[] {
  const inputs = readResourceInputs(moduleDoc);
  if (inputs.length === 0) return [];
  const meta = moduleDoc.metadata as
    | { source?: string; sourceLine?: number }
    | undefined;
  return inputs.map((input) => ({
    kind: input.kind,
    metadata: {
      name: input.name,
      ...(ownModule ? { module: ownModule } : {}),
      source: meta?.source ?? "",
      sourceLine: meta?.sourceLine ?? 0,
      [INJECTED]: true,
    },
  })) as unknown as ResourceManifest[];
}

/** How many times a library is instantiated in one application. `isolated` —
 *  the default, and what every published module was written against — gives
 *  each import declaration its own child scope with its own instances;
 *  `shared` makes the library a singleton every import resolves to. */
export type LibraryLifecycle = "isolated" | "shared";

/** Read a module document's `lifecycle:`. `Telo.Application` has a field of the
 *  same name with a different default and no reader; this is the LIBRARY
 *  question only, so it answers `isolated` for anything else. */
export function readLibraryLifecycle(moduleDoc: unknown): LibraryLifecycle {
  const doc = moduleDoc as { kind?: unknown; lifecycle?: unknown } | undefined;
  if (doc?.kind !== "Telo.Library") return "isolated";
  return doc.lifecycle === "shared" ? "shared" : "isolated";
}
