/**
 * Static validation of the `x-telo-type` annotation itself — the strict half of
 * the accessor split, and the `validate-ref-slots.ts` precedent.
 *
 * `readValueTypeSlot` is deliberately lenient: it reports whatever it can read,
 * returning a slot with no `entry` for a name it does not know. That leniency is
 * what lets every surface keep working; this pass is what stops it becoming
 * silence. Before the unification an unrecognized brand simply resolved to
 * `undefined` and the slot quietly lost its identity — the same class of failure
 * `X_TELO_REF_INVALID_USE` exists to prevent for `use` tokens.
 *
 * The vocabulary is CLOSED and `Telo.`-qualified, so there is nothing here to
 * resolve against an alias scope: a name is a built-in or it is a mistake. A
 * SHAPE is a different thing entirely and is named with the reference tag, which
 * carries its own resolution and its own diagnostics — this pass never sees one,
 * because `resolveSchemaTypeRefs` has already turned it into a `$ref`.
 *
 * Scoping follows `X_TELO_REF_UNRESOLVED`: reported only for manifests in the
 * entry's own modules, since a published dependency is not the consumer's to fix.
 *
 * Browser-safe: no Node built-ins.
 */
import { readValueTypeSlot, VALUE_TYPES, X_TELO_TYPE, type ResourceManifest } from "@telorun/sdk";
import { distance } from "./levenshtein.js";
import { isInSchemaRegion } from "./schema-region.js";

export interface ValueTypeSlotIssue {
  code: "X_TELO_TYPE_UNKNOWN" | "X_TELO_TYPE_ARGUMENT_UNKNOWN";
  manifest: ResourceManifest;
  /** Dotted path to the annotated schema node, e.g. `schema.properties.body`. */
  path: string;
  message: string;
  /** The whole-value replacement that repairs it, when one is derivable. A
   *  misspelled name has a single correct spelling and the annotation's value is
   *  that name, so the repair is the primitive `DiagnosticFix` already carries —
   *  computing a suggestion and printing it in prose alone leaves the author to
   *  retype what the analyzer already knows. Only for the bare-name spelling: the
   *  object form's name is nested, and a whole-value replacement there would
   *  discard the type arguments beside it. */
  fix?: { replacement: string };
}

/** Schema regions are reached by ANCESTRY, not by root key — see
 *  `schema-region.ts`. Walking a manifest's root fields covers only a fraction of
 *  the sites an author writes a schema at: an API route's `request.schema.body`
 *  sits under `routes`, and a check that never reaches it is a hole in exactly
 *  the diagnostic that exists to stop an unknown name degrading silently. */

/** The closest declared type name within an edit-distance threshold, or
 *  undefined. Mirrors `computeSuggestKind`: case-sensitive, and silent on a tie,
 *  because a coin-flip suggestion is worse than none. */
function suggestValueType(name: string): string | undefined {
  if (!name) return undefined;
  const threshold = Math.min(3, Math.floor(name.length / 3));
  if (threshold < 1) return undefined;
  let best: string | undefined;
  let bestDist = threshold + 1;
  let tied = false;
  for (const candidate of VALUE_TYPES.keys()) {
    const d = distance(name, candidate);
    if (d < bestDist) {
      best = candidate;
      bestDist = d;
      tied = false;
    } else if (d === bestDist) {
      tied = true;
    }
  }
  return !best || bestDist > threshold || tied ? undefined : best;
}

function declaredNames(): string {
  return [...VALUE_TYPES.keys()].join(", ");
}

/** Report the annotation on one schema node. */
function checkNode(
  node: Record<string, unknown>,
  manifest: ResourceManifest,
  path: string,
  issues: ValueTypeSlotIssue[],
): void {
  const slot = readValueTypeSlot(node);
  if (!slot) return;

  if (!slot.entry) {
    const suggestion = suggestValueType(slot.name);
    // Only the bare-name spelling can carry the repair: it IS the annotation's
    // whole value, which is the only shape `DiagnosticFix` describes.
    const bareName = typeof (node as Record<string, unknown>)[X_TELO_TYPE] === "string";
    issues.push({
      code: "X_TELO_TYPE_UNKNOWN",
      manifest,
      path,
      message:
        `'${slot.name || "(missing name)"}' is not a value type. ` +
        (suggestion ? `Did you mean '${suggestion}'? ` : "") +
        `Declared types: ${declaredNames()}. A value type names how a value is ` +
        `REPRESENTED and is kernel-owned; to name a shape, reference it with !ref.`,
      ...(suggestion && bareName ? { fix: { replacement: suggestion } } : {}),
    });
    return;
  }

  const declared = new Set(slot.entry.parameters.map((p) => p.name));
  for (const argument of Object.keys(slot.args)) {
    if (declared.has(argument)) continue;
    issues.push({
      code: "X_TELO_TYPE_ARGUMENT_UNKNOWN",
      manifest,
      path,
      message:
        `'${slot.entry.name}' declares no type parameter '${argument}'. ` +
        (declared.size > 0
          ? `Its parameters: ${[...declared].join(", ")}.`
          : `It takes no type parameters.`),
    });
  }
}

/** Walk a schema value, reporting every annotation it carries.
 *
 *  Descends through every container rather than through a keyword list: a value
 *  type is legal at any schema position — a property, an item, a union branch, a
 *  `$defs` entry, a type argument — and enumerating positions is how a check
 *  ends up not covering the one an author used. */
function walk(
  value: unknown,
  manifest: ResourceManifest,
  path: string,
  segments: (string | number)[],
  seen: Set<object>,
  issues: ValueTypeSlotIssue[],
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      walk(item, manifest, `${path}[${i}]`, [...segments, i], seen, issues),
    );
    return;
  }
  const node = value as Record<string, unknown>;
  // Report only inside a schema region. The walk itself is unbounded — reporting
  // is safe anywhere, unlike a rewrite — but an `x-telo-type` key sitting in a
  // resource's own configuration is not a schema annotation and is not this
  // check's to judge.
  if (isInSchemaRegion([...segments, X_TELO_TYPE])) {
    checkNode(node, manifest, path, issues);
  }
  for (const [key, child] of Object.entries(node)) {
    // The annotation's own value is read by `checkNode`; descending into it
    // would report the type ARGUMENTS as if they were annotated nodes of their
    // own. Their turn comes below, as ordinary schema nodes.
    if (key === X_TELO_TYPE) {
      // Walk the NORMALIZED arguments, so a bare-name argument (`of: Telo.Bytes`)
      // is checked exactly as its expanded form is — the sugar must not be a
      // hole in the check that exists to catch a misspelled name.
      const slot = readValueTypeSlot(node);
      for (const [argName, argValue] of Object.entries(slot?.args ?? {})) {
        walk(
          argValue,
          manifest,
          `${path}.${X_TELO_TYPE}.${argName}`,
          [...segments, X_TELO_TYPE, argName],
          seen,
          issues,
        );
      }
      continue;
    }
    walk(child, manifest, path ? `${path}.${key}` : key, [...segments, key], seen, issues);
  }
}

/** Every `x-telo-type` problem in one manifest, wherever a schema is written. */
export function validateValueTypeSlots(manifest: ResourceManifest): ValueTypeSlotIssue[] {
  const issues: ValueTypeSlotIssue[] = [];
  walk(manifest, manifest, "", [], new Set<object>(), issues);
  return issues;
}
