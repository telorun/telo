import { isRecord } from "../../../lib/utils";
import { stepsFieldName } from "../../../schema-utils";
import { entryListOf } from "./entry-list-model";
import type { TopologyViewContext, TopologyViewDescriptor } from "./topology-view";
import { ResourceFormView, RouterView } from "./views/adapters";
import { EntriesView } from "./views/EntriesView";
import { LevelsView } from "./views/LevelsView";
import { StepsView } from "./views/StepsView";
import { SubflowCanvas } from "./views/SubflowCanvas";

/**
 * Every topology view, in preference order — the first applicable one is what a
 * surface with no user choice renders.
 *
 * A static array rather than runtime `register()` calls: these are all in-tree,
 * so a literal keeps the set tree-shakeable and exhaustively typed, and there is
 * no host to hand a registration API to. That changes the day a view can arrive
 * from outside the editor, and not before.
 *
 * Adding a view is this array plus one file. It is not an edit to
 * `TopologyViewProps`, which is the property the contract is shaped to protect.
 */
export const TOPOLOGY_VIEWS: readonly TopologyViewDescriptor[] = [
  // A kind that declares its own topology outranks the generic containment
  // views AT DEPTH, and only there: descending onto a `Run.Sequence` is asking
  // for its steps, which is what the kind declared a canvas to show. At the root
  // the module's own views come first, and these do not apply at all.
  {
    id: "router",
    label: "Routes",
    description: "Route table of an HTTP-style router.",
    Component: RouterView,
    supports: (ctx) => ctx.kind?.topology === "Router",
    consumes: (schema) => named(entryListOf(schema)?.name),
  },
  // Keyed on the step-body ANNOTATION, not on `topology: Sequence`. A step body
  // is a shared manifest fragment, so any kind can carry one; the per-kind opt-in
  // covered only the kinds written before that was true, and a composer adopting
  // the fragment would have got no view at all.
  {
    id: "sequence",
    label: "Steps",
    description: "The body this kind runs, in order.",
    Component: StepsView,
    supports: (ctx) => ctx.hasSteps,
    consumes: (schema) => named(stepsFieldName(schema)),
  },
  // Keyed on the entry-list ANNOTATION, like the step list beside it. An entry
  // is a configured attachment — a mount with its path, an MCP tool with its
  // name and description — and the containment views draw only the resource it
  // names, losing both the configuration and the sequence. For a mount the
  // sequence is match order, which makes the loss silent rather than cosmetic.
  {
    id: "entries",
    label: "Entries",
    description: "The list of configured entries, each naming what it dispatches to.",
    Component: EntriesView,
    supports: (ctx) => ctx.hasEntries,
    consumes: (schema) => named(entryListOf(schema)?.name),
  },
  {
    id: "drill",
    label: "Levels",
    description: "One level at a time — the boot sequence, then what is inside each resource.",
    Component: LevelsView,
    supports: (ctx) => ctx.isModuleRoot || ctx.hasInterior,
  },
  {
    id: "subflow",
    label: "Nested",
    description: "Containers drawn around their contents — the whole shape at once.",
    Component: SubflowCanvas,
    supports: (ctx) => ctx.isModuleRoot || ctx.hasInterior,
  },
  {
    id: "form",
    label: "Fields",
    description: "The resource's own configuration.",
    Component: ResourceFormView,
    supports: (ctx) => !ctx.isModuleRoot,
    // The form IS every property, so it consumes all of them and the rail
    // beside it renders nothing — the "hide the rail on the form view" rule,
    // stated as the fact it follows from rather than as a special case.
    consumes: (schema) =>
      isRecord(schema.properties) ? Object.keys(schema.properties) : [],
  },
];

/** One field name, or none. */
function named(name: string | undefined | null): string[] {
  return name ? [name] : [];
}

/** The focused kind's properties the active view renders. Empty for a view that
 *  declares nothing — the containment views draw the reference graph rather
 *  than any particular field, so every property stays on the rail. */
export function consumedFields(
  view: TopologyViewDescriptor | null,
  schema: Record<string, unknown> | undefined,
): readonly string[] {
  if (!view?.consumes || !schema) return [];
  return view.consumes(schema);
}

/** Views applicable to what is focused, in preference order. Never empty for a
 *  resolvable resource — `form` accepts anything that is not the module root. */
export function candidateViews(ctx: TopologyViewContext): TopologyViewDescriptor[] {
  return TOPOLOGY_VIEWS.filter((v) => v.supports(ctx));
}

/**
 * Whether navigating into this focus shows anything the detail panel does not.
 *
 * Read off the same candidate set the host would resolve, rather than restated
 * as "has children or declares a topology": that phrasing is the registry's own
 * `supports` predicates spelled a second time, and the two would disagree the
 * first time a view widened what it accepts. `form` is excluded because it is
 * the field editor the panel already renders beside the canvas.
 */
export function worthFocusing(ctx: TopologyViewContext): boolean {
  return candidateViews(ctx).some((v) => v.id !== "form");
}

/**
 * The view to render given a remembered preference. A stale id — a view that
 * has been removed, or one the user picked for a different kind — falls back to
 * the first candidate rather than rendering nothing.
 */
export function resolveView(
  ctx: TopologyViewContext,
  preferredId: string | undefined,
): TopologyViewDescriptor | null {
  const candidates = candidateViews(ctx);
  return candidates.find((v) => v.id === preferredId) ?? candidates[0] ?? null;
}

/**
 * Key the remembered choice is stored under. The candidate SET, not the
 * resource: a preference is an answer to "which of these do I want", so every
 * focus offering the same set shares one — a Router resource remembers one view
 * and module roots another, without a per-resource pile of preferences that
 * would each have to be set once.
 */
export function viewChoiceKey(ctx: TopologyViewContext): string {
  return candidateViews(ctx)
    .map((v) => v.id)
    .join("+");
}
