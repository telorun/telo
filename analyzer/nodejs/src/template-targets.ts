import { localRefName } from "./ref-sentinel-target.js";
import { isExpansionSentinel, isRefSentinel } from "@telorun/templating";
import { isResolvedReference } from "./resolved-reference.js";

/**
 * A templated `Telo.Definition`'s `targets:` — the entries its instance STARTS,
 * in order, when it runs. The template twin of an Application's boot sequence:
 * `run:` forwards one `run()` to one entry, which cannot start a server beside
 * the poller that feeds it; `targets:` runs each listed entry through the
 * kernel's run path, so every one keeps its own trace span and its own effect
 * frame, and all of them stay up for as long as the instance does.
 *
 * An item is a `!ref <entry>`, an inline declaration of a startable kind, or —
 * inside the template body — an `!if` / `!switch` / `!for-each` choosing or
 * emitting either. The expanded body is what is read: an inline target is
 * hoisted into `resources:` under its generated identity
 * (`hoistInlineTargets`, `template-expansion.ts`) and its item becomes the
 * reference to it, judged here by its kind's capability. Read on the written
 * definition, a construct is left to the expansion that decides it.
 *
 * One reader, shared by `telo check` and the kernel, so the two refuse the same
 * manifests with the same words. Browser-safe.
 */

/** A `targets:` item that names an entry. */
export interface TemplateTarget {
  index: number;
  /** The `!ref` source as written (`Self.` kept), or the generated identity of
   *  a hoisted inline target. */
  source: string;
  /** The entry name it resolves to (`Self.` stripped). */
  name: string;
}

export interface TemplateTargetProblem {
  code:
    | "TEMPLATE_TARGETS_INVALID"
    | "TEMPLATE_TARGET_UNKNOWN"
    | "TEMPLATE_TARGETS_WITH_RUN"
    | "TEMPLATE_TARGETS_CAPABILITY";
  path: string;
  message: string;
  /** The nearest entry name, for `TEMPLATE_TARGET_UNKNOWN`. */
  suggestion?: string;
}

const STARTABLE = new Set(["Telo.Service", "Telo.Runnable"]);

/** True when a definition of this capability may declare `targets:` — its
 *  instance runs, so there is a moment to start them. */
export function capabilityStartsTargets(capability: string | undefined): boolean {
  return capability !== undefined && STARTABLE.has(capability);
}

/** The entries a definition's expanded `targets:` starts, in order: each
 *  `!ref`, and each hoisted inline target. Anything else is skipped here;
 *  {@link templateTargetProblems} reports it. */
export function templateTargetsOf(definition: Record<string, unknown>): TemplateTarget[] {
  const raw = definition.targets;
  if (!Array.isArray(raw)) return [];
  const out: TemplateTarget[] = [];
  raw.forEach((item, index) => {
    if (isRefSentinel(item)) out.push({ index, source: item.source, name: localRefName(item) });
    else if (isResolvedReference(item)) out.push({ index, source: item.name, name: item.name });
  });
  return out;
}

/**
 * Everything wrong with a definition's `targets:`. `capability` is the
 * INHERITED one — an `extends` child writes none of its own. `nearest` picks a
 * suggestion for an unknown entry name; the caller owns the distance rule.
 *
 * A definition whose entries are named by CEL (the deprecated form) skips the
 * name check: nothing can decide what such an entry is called.
 */
export function templateTargetProblems(
  definition: Record<string, unknown>,
  capability: string | undefined,
  nearest?: (name: string, candidates: string[]) => string | undefined,
  /** The capability of an inline target's kind, read in the defining module's
   *  scope; absent, an inline target's kind is not judged. */
  capabilityOf?: (kind: string) => string | undefined,
): TemplateTargetProblem[] {
  const raw = definition.targets;
  if (raw === undefined || raw === null) return [];
  const problems: TemplateTargetProblem[] = [];
  if (!Array.isArray(raw)) {
    problems.push({
      code: "TEMPLATE_TARGETS_INVALID",
      path: "targets",
      message:
        "'targets:' must be a list of what to start: '!ref <entry>' naming a 'resources:' entry, or an " +
        "inline declaration of a Telo.Service or Telo.Runnable kind.",
    });
    return problems;
  }

  if (!capabilityStartsTargets(capability)) {
    problems.push({
      code: "TEMPLATE_TARGETS_CAPABILITY",
      path: "targets",
      message:
        `'targets:' starts entries when the instance runs, so it is only valid on a ` +
        `'Telo.Service' or 'Telo.Runnable' definition (found '${capability ?? "<unset>"}').`,
    });
  }

  if (definition.run !== undefined && definition.run !== null) {
    problems.push({
      code: "TEMPLATE_TARGETS_WITH_RUN",
      path: "targets",
      message:
        "'targets:' and 'run:' both say what running this kind does — declare one. " +
        "A single entry is 'targets: [!ref <entry>]'.",
    });
  }

  const entries = Array.isArray(definition.resources) ? definition.resources : [];
  const names: string[] = [];
  let anyDynamic = false;
  for (const entry of entries) {
    const metadata = (entry as { metadata?: { name?: unknown; xTeloOrigin?: unknown } } | undefined)
      ?.metadata;
    // An entry extraction produced from an inline declaration is not one the
    // author can name.
    if (metadata?.xTeloOrigin) continue;
    // A choice or a family names its declaration on its tag: read on the
    // written definition, that name is an entry the expansion declares.
    const name = metadata?.name;
    if (typeof name === "string") names.push(name);
    else if (name !== undefined) anyDynamic = true;
  }

  raw.forEach((item, index) => {
    const path = `targets[${index}]`;
    // A choice or a repeat is judged in the expansion that decides it.
    if (isExpansionSentinel(item)) return;
    if (isResolvedReference(item) || isInlineTarget(item)) {
      const kind = (item as { kind: string }).kind;
      const found = capabilityOf?.(kind);
      if (found !== undefined && !STARTABLE.has(found)) {
        problems.push({
          code: "TEMPLATE_TARGETS_CAPABILITY",
          path,
          message:
            `'${path}' declares a ${kind}, whose capability is '${found}'; a target is started when the ` +
            `instance runs, so it is a Telo.Service or Telo.Runnable.`,
        });
      }
      return;
    }
    if (!isRefSentinel(item)) {
      problems.push({
        code: "TEMPLATE_TARGETS_INVALID",
        path,
        message:
          `'${path}' must be '!ref <entry>', naming a 'resources:' entry to start, or an inline ` +
          `declaration of a Telo.Service or Telo.Runnable kind.`,
      });
      return;
    }
    const name = localRefName(item);
    if (names.includes(name) || anyDynamic) return;
    const suggestion = nearest?.(name, names);
    problems.push({
      code: "TEMPLATE_TARGET_UNKNOWN",
      path,
      message:
        `'${path}: !ref ${item.source}' names no entry in 'resources:'. ` +
        `Available: ${names.join(", ") || "(none)"}.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : ""),
      ...(suggestion ? { suggestion } : {}),
    });
  });
  return problems;
}

/** An inline declaration written as a target: a mapping with a `kind`. */
function isInlineTarget(item: unknown): boolean {
  return (
    !!item &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    typeof (item as { kind?: unknown }).kind === "string" &&
    !isRefSentinel(item)
  );
}
