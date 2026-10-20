import type { RefSlot } from "@telorun/analyzer";
import type { JsonSchema, OutputRefusals, ViewModel } from "@telorun/editor-protocol";
import { outputSlotSites } from "@telorun/ide-support";
import type { RefCandidate, RefResolver } from "../components/resource-schema-form/ref-candidates";
import type { AvailableKind } from "../model";

/**
 * What the structured views ask about kinds and reference slots of one module,
 * answered from the view model its engine serves: which kinds fill a slot,
 * which a new resource could be declared as, why a resource cannot fill a slot
 * by what it returns, a kind's invocation contract and the module document's
 * own schema.
 */
export interface StructuredModel extends RefResolver {
  userFacingKindsForRef(refTarget: string): string[] | undefined;
  outputRefusal(slot: RefSlot, candidate: RefCandidate): string[];
  /** The kind's resolved input contract; undefined when it declares none. */
  inputTypeForKind(kind: string): JsonSchema | undefined;
  /** The kind's resolved output contract; undefined when it declares none. */
  outputTypeForKind(kind: string): JsonSchema | undefined;
  /** The schema of the module document's own kind. */
  moduleRootSchema(): JsonSchema | undefined;
  /** The same answers with the candidates of `outputRefusal` the entries of
   *  the templated kind `kindId`'s body — a body names its own entries, so a
   *  name there is never one of the module's resources. */
  forTemplate(kindId: string): StructuredModel;
}

const models = new WeakMap<ViewModel, WeakMap<ReadonlyMap<string, AvailableKind>, StructuredModel>>();

/**
 * The structured views' questions over `model`, built once per model and kind
 * table. `kinds` is the module's own kind table (its `viewData`), whose
 * schemas are the ones the views read slots from: an output verdict is found
 * by the slot's place in its kind's schema, which the engine derives from the
 * same schema as its author wrote it.
 */
export function structuredModelOf(
  model: ViewModel,
  kinds: ReadonlyMap<string, AvailableKind>,
): StructuredModel {
  let byKinds = models.get(model);
  if (!byKinds) models.set(model, (byKinds = new WeakMap()));
  const known = byKinds.get(kinds);
  if (known) return known;
  const built = build(model, kinds, model.outputRefusals, new Map());
  byKinds.set(kinds, built);
  return built;
}

function build(
  model: ViewModel,
  kinds: ReadonlyMap<string, AvailableKind>,
  refusals: OutputRefusals[],
  scopes: Map<string, StructuredModel>,
): StructuredModel {
  // A kind already canonical resolves to itself: the view model maps every
  // spelling written in the closure, and names a canonical kind wherever it
  // states a fact about one.
  const canonical = new Set<string>([
    ...Object.values(model.kindSpellings),
    ...Object.values(model.refConstraints).flatMap((c) => c.accepted),
    ...Object.keys(model.contracts),
    ...Object.keys(model.templates),
    ...(model.moduleGraph?.kinds.map((k) => k.id) ?? []),
  ]);
  const resolveKind = (kind: string): string | undefined =>
    model.kindSpellings[kind] ?? (canonical.has(kind) ? kind : undefined);
  const accepted = new Map<string, Set<string>>();
  const contractOf = (kind: string) => model.contracts[resolveKind(kind) ?? kind];
  let slots: WeakMap<object, string> | undefined;
  let verdicts: Map<string, Record<string, string[]>> | undefined;

  return {
    resolveKind,
    acceptedKindsForRef(refTarget) {
      const constraint = model.refConstraints[refTarget];
      if (!constraint) return undefined;
      let kinds = accepted.get(refTarget);
      if (!kinds) accepted.set(refTarget, (kinds = new Set(constraint.accepted)));
      return kinds;
    },
    userFacingKindsForRef: (refTarget) => model.refConstraints[refTarget]?.userFacing,
    outputRefusal(slot, candidate) {
      if (!slot.outputType || candidate.name === undefined) return [];
      slots ??= slotAddresses(kinds, resolveKind);
      verdicts ??= new Map(refusals.map((entry) => [`${entry.kind}#${entry.pointer}`, entry.refusals]));
      const address = slots.get(slot.outputType);
      return (address === undefined ? undefined : verdicts.get(address)?.[candidate.name]) ?? [];
    },
    inputTypeForKind: (kind) => contractOf(kind)?.inputType,
    outputTypeForKind: (kind) => contractOf(kind)?.outputType,
    moduleRootSchema: () => model.moduleRootSchema ?? undefined,
    forTemplate(kindId) {
      let scoped = scopes.get(kindId);
      if (!scoped) {
        scoped = build(model, kinds, model.templates[kindId]?.outputRefusals ?? [], scopes);
        scopes.set(kindId, scoped);
      }
      return scoped;
    },
  };
}

/** Each output-constrained slot of the module's kinds, by the `outputType`
 *  object a reader of that schema holds, addressed `<canonical kind>#<pointer>`
 *  as the view model addresses its verdicts. A kind the model cannot resolve
 *  is left out, and its slots withhold nothing. */
function slotAddresses(
  kinds: ReadonlyMap<string, AvailableKind>,
  resolveKind: (kind: string) => string | undefined,
): WeakMap<object, string> {
  const out = new WeakMap<object, string>();
  for (const [spelling, kind] of kinds) {
    const canonical = resolveKind(spelling);
    if (!canonical) continue;
    for (const { pointer, slot } of outputSlotSites(kind.schema)) {
      if (slot.outputType && !out.has(slot.outputType)) out.set(slot.outputType, `${canonical}#${pointer}`);
    }
  }
  return out;
}
