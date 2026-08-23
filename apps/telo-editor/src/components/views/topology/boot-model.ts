import { isTaggedSentinel } from "@telorun/templating";
import type { GraphNode, TypeSignature } from "./application-canvas-model";
import type { ContainmentTree } from "./containment";
import { refTargetName } from "./overview-graph";
import { conditionText } from "./step-list-model";

/**
 * What an Application boots, and what it declares but never starts.
 *
 * `targets:` is a FLAT boot sequence — the manifest's own words — so the honest
 * shape for it is an ordered list, not a graph. The graph earns its keep one
 * level down (a router's routes, a sequence's steps), which is what the drill
 * and nested canvases render; at the root it draws a list as a DAG.
 *
 * Both halves read the relation the canvases already fold (`ContainmentTree`),
 * never a second walk of their own, so the list and the pictures cannot disagree
 * about what is wired to what.
 */

/** How the author wrote one `targets:` entry. Four shapes are legal and the
 *  list has to survive all of them, since it edits their POSITIONS. */
export type BootTargetForm =
  /** A bare reference — `!ref server`, or the legacy plain name. */
  | "ref"
  /** `{ ref, when }` — run this only if the condition holds. */
  | "gated"
  /** `{ name?, invoke, inputs?, when? }` — an inline invoke step. */
  | "step"
  /** Something else entirely; rendered verbatim and never interpreted. */
  | "unknown";

export interface BootTarget {
  /** Position in `targets:`. Every edit this row makes is written at
   *  `/targets/<index>`, so it is identity as well as order. */
  index: number;
  form: BootTargetForm;
  /** The resource the entry starts, when it names one. */
  name?: string;
  /** A gated entry's condition or an inline step's, as authored. */
  when?: string;
  /** An inline step's own name, which is what `steps.<name>.result` reads. */
  stepName?: string;
  /** The entry names a resource this module does not declare. Reported rather
   *  than hidden: a boot sequence pointing at nothing is why an app fails to
   *  start, and the row is the only place it is visible in this view. */
  unresolved: boolean;
  /**
   * Where this step's arguments live and what they must satisfy — present only
   * for a `step` entry whose target declares an input contract.
   *
   * A bare or gated entry has none by construction: those are `run()`, which the
   * invocation contract defines as parameterless and void. And an unresolvable
   * contract yields nothing rather than a freeform object: with no `properties`
   * and no value schema the form falls through to its JSON-SCHEMA editor, which
   * would write a schema declaration where arguments belong.
   */
  inputs?: { pointer: string; schema: Record<string, unknown> };
  /** The argument names currently written, so a row can say whether it is
   *  carrying any without the reader opening it. */
  inputKeys?: string[];
  /** What the step produces, when its target declares it. Read by LATER targets
   *  as `steps.<name>.result`, which is what makes it worth showing at all. */
  output?: TypeSignature;
}

/** The declared call signature of one resource, as the canvas already resolved
 *  it — instance field first, then the kind. Passed in rather than re-derived so
 *  the list and the canvas's signature pills cannot disagree. */
export interface TargetSignature {
  input?: TypeSignature;
  output?: TypeSignature;
}

/**
 * Ambient resources of one capability.
 *
 * The canvas model keeps providers and types in ONE list because neither is
 * drawable as a node — a fact about pictures, not about the resources. This view
 * asks a different question ("what runs, and what reaches what"), and there they
 * differ: a provider has a runtime instance and is read as a VALUE through CEL,
 * while a type has no instance at all and IS referenced, by a slot naming it as
 * a shape. One sentence cannot describe both without being false about one.
 *
 * Grouped generically by capability rather than split on a `Telo.Type` test, so
 * a third ambient capability gets its own group instead of landing silently in
 * whichever bucket the test defaulted to — which is the failure this fixes.
 */
export interface AmbientGroup {
  capability: string;
  items: GraphNode[];
}

export interface BootModel {
  targets: BootTarget[];
  /**
   * Declared resources nothing references — no boot target, and no other
   * resource's slot either.
   *
   * Referrer count, not reachability from boot: a resource wired into something
   * that itself never runs is a different problem with a different fix, and
   * conflating the two would put half the module in this list the moment one
   * target was removed. Providers and types are absent by construction — they
   * are consumed through CEL value flow rather than through an edge, so the
   * canvas model keeps them out of `nodes` entirely and nothing here has to
   * know their capability names.
   *
   * A Library's EXPORTED instances are excluded too. Their referrers are
   * importers, which are outside this module by definition, so counting only
   * what this module references would report a library's entire public surface
   * as unwired — the list would be loudest about exactly the resources that are
   * doing their job.
   */
  unreferenced: GraphNode[];
  /** Providers and types, one group per capability. Empty groups are absent. */
  ambient: AmbientGroup[];
}

/** Capability order for the ambient groups. A capability outside it keeps its
 *  place in encounter order after these — unknown, not unordered. */
const AMBIENT_ORDER = ["Telo.Provider", "Telo.Type"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads one `targets:` entry into the row the list renders. */
export function readBootTarget(
  entry: unknown,
  index: number,
  declared: Set<string>,
  signatureOf: (resourceName: string) => TargetSignature | undefined = () => undefined,
): BootTarget {
  const record = asRecord(entry);
  // A sentinel is a tagged object, so it has to be tested before the object
  // forms — `!ref server` is a record whose keys are the sentinel's, not an
  // entry with a `ref:` or an `invoke:`.
  const sentinel = isTaggedSentinel(entry);

  if (record && !sentinel && "invoke" in record) {
    const name = refTargetName(record.invoke);
    const signature = name ? signatureOf(name) : undefined;
    const inputSchema = signature?.input?.schema;
    const written = asRecord(record.inputs);
    return {
      index,
      form: "step",
      ...(name ? { name } : {}),
      ...(conditionText(record.when) ? { when: conditionText(record.when)! } : {}),
      ...(typeof record.name === "string" ? { stepName: record.name } : {}),
      ...(inputSchema
        ? { inputs: { pointer: `/targets/${index}/inputs`, schema: inputSchema } }
        : {}),
      ...(written ? { inputKeys: Object.keys(written) } : {}),
      ...(signature?.output ? { output: signature.output } : {}),
      unresolved: !!name && !declared.has(name),
    };
  }

  if (record && !sentinel && "ref" in record) {
    const name = refTargetName(record.ref);
    return {
      index,
      form: "gated",
      ...(name ? { name } : {}),
      ...(conditionText(record.when) ? { when: conditionText(record.when)! } : {}),
      unresolved: !!name && !declared.has(name),
    };
  }

  const name = refTargetName(entry);
  if (name === undefined) return { index, form: "unknown", unresolved: false };
  return { index, form: "ref", name, unresolved: !declared.has(name) };
}

/**
 * The boot list for one module.
 *
 * `targets` is read from the manifest array rather than from the tree's root
 * children, because this list EDITS positions: the tree folds several edges to
 * one node into a single link, so an index taken from it would name the wrong
 * entry the moment a resource appeared twice.
 */
export function buildBootModel(
  targets: readonly unknown[],
  declaredNames: readonly string[],
  tree: ContainmentTree | null,
  /** A Library's `exports.resources`, as authored. A `<Alias>.<name>` entry
   *  re-exports someone else's instance and names nothing local, so only the
   *  bare entries can exclude anything here. */
  exportedNames: readonly string[] = [],
  /** The canvas model's ambient resources — its `stripItems`. */
  ambientNodes: readonly GraphNode[] = [],
  /** Declared call signatures, by resource name. */
  signatureOf: (resourceName: string) => TargetSignature | undefined = () => undefined,
): BootModel {
  const declared = new Set(declaredNames);
  const exported = new Set(exportedNames.filter((name) => !name.includes(".")));
  return {
    targets: targets.map((entry, i) => readBootTarget(entry, i, declared, signatureOf)),
    ambient: groupAmbient(ambientNodes),
    unreferenced: tree
      ? [...tree.nodeById.values()].filter(
          (node) =>
            !node.isRoot &&
            !exported.has(node.name) &&
            (tree.referrers.get(node.name) ?? 0) === 0,
        )
      : [],
  };
}

/** One group per capability present, in `AMBIENT_ORDER` and then in encounter
 *  order. Preserves each group's own item order, which is the manifest's. */
function groupAmbient(nodes: readonly GraphNode[]): AmbientGroup[] {
  const byCapability = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const items = byCapability.get(node.capability);
    if (items) items.push(node);
    else byCapability.set(node.capability, [node]);
  }
  const rank = (capability: string) => {
    const i = AMBIENT_ORDER.indexOf(capability);
    return i === -1 ? AMBIENT_ORDER.length : i;
  };
  return [...byCapability.entries()]
    .map(([capability, items]) => ({ capability, items }))
    .sort((a, b) => rank(a.capability) - rank(b.capability));
}
