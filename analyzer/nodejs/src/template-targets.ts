import { isRefSentinel } from "@telorun/templating";

/**
 * A templated `Telo.Definition`'s `targets:` — the entries its instance STARTS,
 * in order, when it runs. The template twin of an Application's boot sequence:
 * `run:` forwards one `run()` to one entry, which cannot start a server beside
 * the poller that feeds it; `targets:` runs each listed entry through the
 * kernel's run path, so every one keeps its own trace span and its own effect
 * frame, and all of them stay up for as long as the instance does.
 *
 * One reader, shared by `telo check` and the kernel, so the two refuse the same
 * manifests with the same words. Browser-safe.
 */

/** A `targets:` item that names an entry. */
export interface TemplateTarget {
  index: number;
  /** The `!ref` source as written (`Self.` kept). */
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

/** The `!ref` items of a definition's `targets:`, in order. Items that are not a
 *  `!ref` are skipped here; {@link templateTargetProblems} reports them. */
export function templateTargetsOf(definition: Record<string, unknown>): TemplateTarget[] {
  const raw = definition.targets;
  if (!Array.isArray(raw)) return [];
  const out: TemplateTarget[] = [];
  raw.forEach((item, index) => {
    if (!isRefSentinel(item)) return;
    const source = item.source;
    const name = source.startsWith("Self.") ? source.slice("Self.".length) : source;
    out.push({ index, source, name });
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
): TemplateTargetProblem[] {
  const raw = definition.targets;
  if (raw === undefined || raw === null) return [];
  const problems: TemplateTargetProblem[] = [];
  if (!Array.isArray(raw)) {
    problems.push({
      code: "TEMPLATE_TARGETS_INVALID",
      path: "targets",
      message: "'targets:' must be a list of '!ref <entry>', each naming a 'resources:' entry to start.",
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
    const name = metadata?.name;
    if (typeof name === "string") names.push(name);
    else if (name !== undefined) anyDynamic = true;
  }

  raw.forEach((item, index) => {
    const path = `targets[${index}]`;
    if (!isRefSentinel(item)) {
      problems.push({
        code: "TEMPLATE_TARGETS_INVALID",
        path,
        message: `'${path}' must be '!ref <entry>', naming a 'resources:' entry to start.`,
      });
      return;
    }
    const source = item.source;
    const name = source.startsWith("Self.") ? source.slice("Self.".length) : source;
    if (names.includes(name) || anyDynamic) return;
    const suggestion = nearest?.(name, names);
    problems.push({
      code: "TEMPLATE_TARGET_UNKNOWN",
      path,
      message:
        `'${path}: !ref ${source}' names no entry in 'resources:'. ` +
        `Available: ${names.join(", ") || "(none)"}.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : ""),
      ...(suggestion ? { suggestion } : {}),
    });
  });
  return problems;
}
