import { buildCelSegments, CelParseError } from "@telorun/analyzer";
import type { ViewModel } from "@telorun/editor-protocol";
import { walkCel } from "@telorun/ide-support";
import { walkCelExpressions } from "@telorun/templating";
import { isModuleRootKind, moduleRootResource } from "./application-adapter";
import { refTargetName } from "./components/views/topology/ref-target-name";
import type { ViewModelStatus } from "./language/view-model-store";
import { readConcretePath } from "./lib/concrete-path";
import type { ParsedManifest, ParsedResource } from "./model";

/**
 * Every place in a module that names a given resource.
 *
 * ONE walk, two questions: whether a resource may be deleted, and — once it is —
 * which slots have to be cleared. Those were the same question asked once (the
 * prune) and not at all (nothing asked before deleting), which is how deleting
 * could silently blank a slot on a resource the user was not looking at.
 *
 * TWO WAYS, because a resource is reached two ways and only one of them is
 * repairable. A `!ref` slot is a value the editor can write null into; a CEL
 * read (`resources.db.url`) is an expression only its author can rewrite — which
 * is exactly why a delete is refused rather than cascaded. Leaving the CEL half
 * out would have made the check useless for PROVIDERS, whose whole nature is to
 * be read through CEL rather than pointed at by an edge.
 */
export interface ResourceReference {
  /** How the resource is reached: a reference slot, or a CEL expression. */
  via: "ref" | "cel";
  /** The resource whose field holds it. */
  source: { kind: string; name: string };
  /** Where in that resource. For `via: "ref"` this is the concrete path
   *  `writeConcretePath` addresses, which is what makes a ref clearable; for
   *  `via: "cel"` it is the field path the expression sits at, and is for
   *  reading only. */
  path: string;
}

/**
 * References to `name` across the module, excluding the resource's own: the
 * reference slots read from the module's view model — the reference sites its
 * engine found — and the CEL reads from `manifest`.
 *
 * A self-reference is not a reason to refuse: the field holding it goes away
 * with the resource that declares it, so reporting it would tell the user to
 * delete the thing they are already deleting. The sites are those of the
 * analysis the engine last ran, so a caller holding a manifest from after an
 * edit asks about the edit's own resources.
 *
 * The module root rides along as a resource, so an Application's `targets` is
 * an ordinary referrer rather than a case anyone has to remember.
 */
export function findViewModelReferences(
  model: ViewModel,
  manifest: ParsedManifest,
  name: string,
): ResourceReference[] {
  const sites = model.referenceSites
    .filter((site) => site.target === name && site.source.name !== name)
    .map((site): ResourceReference => ({ via: "ref", source: site.source, path: site.path }));
  return [...sites, ...celReferences(moduleResources(manifest), name)];
}

/**
 * The reference slots a delete of `deleted` clears: each site the view model
 * found naming it whose value in `manifest` — the module as it is now, the
 * delete applied — still names it.
 *
 * The sites are the engine's last analysis, which may predate an edit, and
 * clearing a slot splices an array item without looking at it: two deletes
 * before the engine catches up would otherwise clear the second one's stale
 * index, which by then holds a sibling. So a site is cleared only when its live
 * value is the reference, and one written since the analysis is left in place
 * for the engine to report as dangling.
 */
export function referenceSlotsToClear(
  model: ViewModel,
  manifest: ParsedManifest,
  deleted: string,
): ResourceReference[] {
  return findViewModelReferences(model, manifest, deleted).filter((ref) => {
    if (ref.via !== "ref") return false;
    const source =
      manifest.resources.find((r) => r.kind === ref.source.kind && r.name === ref.source.name) ??
      (isModuleRootKind(ref.source.kind) ? moduleRootResource(manifest) : undefined);
    return source !== undefined && refTargetName(readConcretePath(source.fields, ref.path)) === deleted;
  });
}

/** What names a resource, when the module's view model can say. */
export type KnownReferences =
  | { known: true; references: ResourceReference[] }
  /** Unknown, not empty: `reason` says why when it is not that the analysis
   *  is still running. */
  | { known: false; reason?: string };

/**
 * What still names `name` in `manifest`, or that it cannot be known: the view
 * model is not ready, or `isCurrent` says it was computed from text the editor
 * has since changed — its sites would then miss a reference written since.
 * Reading either as "nothing" is what would let a still-referenced resource be
 * removed unchecked.
 */
export function knownReferences(
  status: ViewModelStatus | undefined,
  isCurrent: (model: ViewModel) => boolean,
  manifest: ParsedManifest,
  name: string,
): KnownReferences {
  if (status?.state === "unsupported") {
    const version = status.version ? `Telo ${status.version}` : "The telo version this module is edited against";
    return {
      known: false,
      reason: `${version} predates structured editing, so what still names it cannot be checked here — edit this module in the source view.`,
    };
  }
  if (status?.state === "failed") return { known: false, reason: `What still names it cannot be checked: ${status.error}` };
  if (status?.state !== "ready" || !isCurrent(status.model)) return { known: false };
  return { known: true, references: findViewModelReferences(status.model, manifest, name) };
}

/** The module's resources, its module document riding along as one. */
function moduleResources(manifest: ParsedManifest): ParsedResource[] {
  return [...manifest.resources.filter((r) => !isModuleRootKind(r.kind)), moduleRootResource(manifest)];
}

/** CEL expressions reading `resources.<name>`, one entry per expression however
 *  many times it reads it — the author edits the expression, not the read. */
function celReferences(resources: ParsedResource[], name: string): ResourceReference[] {
  const out: ResourceReference[] = [];
  for (const resource of resources) {
    if (resource.name === name) continue;
    walkCelExpressions(resource.fields, "", (source, path, engine) => {
      if (!readsResource(source, engine, name)) return;
      out.push({ via: "cel", source: { kind: resource.kind, name: resource.name }, path });
    });
  }
  return out;
}

/**
 * Whether one CEL body reads `resources.<name>`.
 *
 * Parsed, never matched as text: `"resources.db"` inside a string literal names
 * nothing, and refusing a delete over it would be a wall with no way through.
 * An expression that does not parse is skipped — the author is mid-edit and the
 * analyzer already reports the syntax error; only that failure is tolerated.
 */
function readsResource(source: string, engine: string, name: string): boolean {
  // The tag's own segments — the whole `!cel` body, or each hole. Offsets are
  // irrelevant here — nothing navigates back to the document.
  for (const segment of buildCelSegments(source, 0, `!${engine}`, source)) {
    let hit = false;
    try {
      walkCel(segment.ast(), (node) => {
        if (node.kind !== "member" || node.property !== name) return;
        if (node.target.kind === "ident" && node.target.name === "resources") hit = true;
      });
    } catch (error) {
      if (error instanceof CelParseError) continue;
      throw error;
    }
    if (hit) return true;
  }
  return false;
}
