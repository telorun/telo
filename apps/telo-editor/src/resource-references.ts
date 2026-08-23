import { buildCelSegments, CelParseError, type AnalysisRegistry } from "@telorun/analyzer";
import { walkCel } from "@telorun/ide-support";
import type { ResourceManifest } from "@telorun/sdk";
import { walkCelExpressions } from "@telorun/templating";
import { isModuleRootKind, moduleRootResource } from "./application-adapter";
import { refTargetName } from "./components/views/topology/overview-graph";
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
 * References to `name` across the module, excluding the resource's own.
 *
 * A self-reference is not a reason to refuse: the field holding it goes away
 * with the resource that declares it, so reporting it would tell the user to
 * delete the thing they are already deleting.
 *
 * The module root rides along as a synthesized manifest, so an Application's
 * `targets` is an ordinary referrer rather than a case anyone has to remember.
 */
export function findResourceReferences(
  registry: AnalysisRegistry,
  manifest: ParsedManifest,
  name: string,
): ResourceReference[] {
  const resources = [
    ...manifest.resources.filter((r) => !isModuleRootKind(r.kind)),
    moduleRootResource(manifest),
  ];
  return [...refSlotReferences(registry, resources, name), ...celReferences(resources, name)];
}

/**
 * Reference slots naming `name`, through the analysis registry's visitor.
 *
 * The visitor rather than the canvas model's edges: an edge exists only between
 * two NODES, so a reference to a provider or a type — ambient, drawn in no
 * picture — carries no edge at all, and those are precisely the resources this
 * is asked about.
 */
function refSlotReferences(
  registry: AnalysisRegistry,
  resources: ParsedResource[],
  name: string,
): ResourceReference[] {
  const asManifest = (r: ParsedResource) =>
    ({ kind: r.kind, metadata: { name: r.name }, ...r.fields }) as unknown as ResourceManifest;

  const out: ResourceReference[] = [];
  registry.visitManifest(
    resources.map(asManifest),
    {
      onRef: (e) => {
        if (refTargetName(e.value) !== name) return;
        const sourceName = e.source.metadata?.name;
        if (typeof e.source.kind !== "string" || typeof sourceName !== "string") return;
        if (sourceName === name) return;
        out.push({ via: "ref", source: { kind: e.source.kind, name: sourceName }, path: e.concretePath });
      },
    },
    { expand: true, discoverNestedRefs: true },
  );
  return out;
}

/** CEL expressions reading `resources.<name>`, one entry per expression however
 *  many times it reads it — the author edits the expression, not the read. */
function celReferences(resources: ParsedResource[], name: string): ResourceReference[] {
  const out: ResourceReference[] = [];
  for (const resource of resources) {
    if (resource.name === name) continue;
    walkCelExpressions(resource.fields, "", (source, path) => {
      if (!readsResource(source, name)) return;
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
function readsResource(source: string, name: string): boolean {
  // One tagged segment, which is what a body already extracted from its scalar
  // is. Offsets are irrelevant here — nothing navigates back to the document.
  for (const segment of buildCelSegments(source, 0, "!cel", source)) {
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
