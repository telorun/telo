/**
 * The arguments a call site declares.
 *
 * A slot that transfers control names its argument slot on its own `x-telo-ref`
 * — `inputs: /inputs`, a JSON Pointer relative to the object enclosing the slot.
 * That is the only thing tying an `inputs:` map to the resource it is arguments
 * FOR: the map itself is an open object, and the reference sits in a sibling
 * field whose name no walker may assume.
 *
 * Reading the pointer here means completion offers exactly the keys the invoked
 * target declares — resolved through the shared contract resolver, so they are
 * the keys `telo check` validates that call against and the kernel binds at
 * dispatch, instance declaration first.
 */
import {
  navigateConcretePath,
  readRefSlot,
  type AnalysisRegistry,
  type ManifestAnalysis,
  type ManifestRef,
} from "@telorun/analyzer";
import { navigateSchema } from "./detect-context.js";

/** Resolve a JSON Pointer that is a plain property path (`/inputs`) into path
 *  segments. Pointers here address a sibling FIELD, never an array element, so
 *  anything else is left alone rather than guessed at. */
function pointerSegments(pointer: string): string[] | undefined {
  if (!pointer.startsWith("/")) return undefined;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.every((s) => s.length > 0 && !/^\d+$/.test(s)) ? segments : undefined;
}

/**
 * The declared input contract of the call whose argument slot is at
 * `concretePath`, or undefined when this path is not one.
 *
 * Both halves have to line up: the enclosing object's schema must declare a ref
 * slot whose `inputs` pointer names this field, and the manifest must fill that
 * ref. Either missing means there is no call here to take arguments for.
 */
export function callInputsAt(
  registry: AnalysisRegistry | undefined,
  analysis: ManifestAnalysis | undefined,
  docKind: string,
  resourceName: string | undefined,
  concretePath: string,
): Record<string, any> | undefined {
  if (!registry || !analysis || !concretePath) return undefined;
  const resource = analysis.resourceFor(docKind, resourceName);
  if (!resource) return undefined;
  const definition = registry.resolveDefinition(docKind);
  if (!definition?.schema) return undefined;

  const segments = concretePath.split(".").map((seg) => seg.replace(/\[\d+\]$/, ""));

  // The pointer is relative to the object ENCLOSING the annotated slot, and it
  // may name a nested field (`/handler/inputs`), so every prefix of this path is
  // a candidate enclosing object — not just the immediate parent. Trying them
  // longest-first keeps the nearest enclosing declaration winning.
  const concreteSegments = concretePath.split(".");
  for (let depth = segments.length - 1; depth >= 0; depth--) {
    const enclosing = segments.slice(0, depth);
    const tail = segments.slice(depth);
    const enclosingSchema = navigateSchema(
      definition.schema as Record<string, any>,
      // Schema navigation is index-free; the concrete path is not.
      enclosing.filter(Boolean),
      (from) => registry.resolveSchemaFrom(from, docKind),
    );
    const properties = enclosingSchema?.properties as Record<string, any> | undefined;
    if (!properties) continue;

    for (const [siblingName, siblingSchema] of Object.entries(properties)) {
      const slot = readRefSlot(siblingSchema);
      if (!slot?.inputs) continue;
      const pointed = pointerSegments(slot.inputs);
      if (!pointed || pointed.length !== tail.length) continue;
      if (!pointed.every((seg, i) => seg === tail[i])) continue;

      const refPath = [...concreteSegments.slice(0, depth), siblingName].filter(Boolean).join(".");
      const ref = navigateConcretePath(resource as Record<string, any>, refPath) as
        | ManifestRef
        | undefined;
      if (!ref || typeof ref !== "object" || !ref.name) continue;
      return analysis.contractFor(ref, "inputType");
    }
  }
  return undefined;
}
