import type { RuntimeDiagnostic } from "@telorun/sdk";

/**
 * Codes that mean "this resource never got its turn": the multi-pass init loop
 * deferred it because a dependency had not initialized, so it never produced a
 * failure of its own. This is the ONLY signal that an entry may be collapsed —
 * see {@link classifyInitFailures}.
 */
export const DEPENDENCY_PENDING_CODES = new Set([
  "ERR_LOCAL_REF_PENDING",
  "ERR_CROSS_MODULE_REF_PENDING",
]);

/** Whether a thrown error is the loop's own "not your turn yet" signal rather
 *  than a failure of the resource. */
export function isDeferral(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code !== undefined && DEPENDENCY_PENDING_CODES.has(code);
}

/** One resource that did not reach the `Initialized` state, with the outbound
 *  edges (names of resources in the SAME context) captured for it. */
export interface FailedResource {
  resource: string;
  kind?: string;
  message: string;
  details?: string;
  code?: string;
  children?: RuntimeDiagnostic[];
  deps: string[];
}

/**
 * Split a failed-resource set into the ones that failed on their own (root
 * causes) and the ones that only failed because something else in the set did.
 *
 * A dependency chain of any length produces one real error and N shadows of it,
 * and the shadows outnumber the cause — reporting them flat buries the only
 * line a reader can act on.
 *
 * **What makes an entry derived is its CODE, never its edges.** Only a
 * {@link DEPENDENCY_PENDING_CODES} deferral says "this resource never ran, so
 * it has nothing of its own to report". A reference edge into the failure set
 * proves an edge exists, not that this entry's failure came from it: a resource
 * can reference a failed dependency AND fail its own schema validation, and
 * collapsing it there would swallow a real, independent error the author has to
 * fix — the second half of a two-error session they would only discover on the
 * next run. (Nor is the edge trustworthy on its own terms: `collectResourceRefs`
 * walks `with:`-scoped inline declarations, whose names resolve scope-locally,
 * so a scoped `!ref Db` can collide with a failed module-level `Db`.)
 *
 * Edges are used for ATTRIBUTION only — they name which failure a deferred
 * entry is waiting on. `blockedBy` is the ROOT of the chain, not the immediate
 * blocker, since that is the name a reader has to go fix; the walk stops at the
 * first entry that is not itself derived. A deferral with no visible edge (a
 * `${{ resources.X }}` read the ref walk cannot see) is still derived, just
 * unattributed.
 *
 * Classification never hides everything: if no entry survives as a root (every
 * failure is a deferral), the whole set is reported unclassified.
 *
 * Returns diagnostics ordered root causes first, then the derived entries.
 */
export function classifyInitFailures(failures: FailedResource[]): RuntimeDiagnostic[] {
  const failed = new Set(failures.map((f) => f.resource));

  const derived = new Set(
    failures.filter((f) => f.code && DEPENDENCY_PENDING_CODES.has(f.code)).map((f) => f.resource),
  );
  // Attribution edges are collected for EVERY entry, derived or not: a chain
  // walk has to pass through an entry to reach the root beyond it.
  const edgeBlocker = new Map<string, string>();
  for (const f of failures) {
    const dep = f.deps.find((n) => n !== f.resource && failed.has(n));
    if (dep !== undefined) edgeBlocker.set(f.resource, dep);
  }

  const rootCauseOf = (name: string): string | undefined => {
    const seen = new Set<string>([name]);
    let current = edgeBlocker.get(name);
    while (current !== undefined && !seen.has(current)) {
      if (!derived.has(current)) return current;
      seen.add(current);
      current = edgeBlocker.get(current);
    }
    return undefined;
  };

  const toDiagnostic = (f: FailedResource, isDerived: boolean): RuntimeDiagnostic => {
    const blockedBy = isDerived ? rootCauseOf(f.resource) : undefined;
    return {
      resource: f.resource,
      kind: f.kind,
      message: f.message,
      details: f.details,
      code: f.code,
      ...(f.children?.length ? { children: f.children } : {}),
      ...(isDerived ? { derived: true, ...(blockedBy ? { blockedBy } : {}) } : {}),
    };
  };

  const roots = failures.filter((f) => !derived.has(f.resource));
  if (roots.length === 0) return failures.map((f) => toDiagnostic(f, false));

  return [
    ...roots.map((f) => toDiagnostic(f, false)),
    ...failures.filter((f) => derived.has(f.resource)).map((f) => toDiagnostic(f, true)),
  ];
}

/** Group the derived entries by the root cause they hang off, so a renderer can
 *  collapse each chain to a single line instead of repeating one failure N
 *  times. Entries whose blocker could not be named group under `undefined`. */
export function groupBlockedResources(
  diagnostics: RuntimeDiagnostic[],
): Map<string | undefined, string[]> {
  const groups = new Map<string | undefined, string[]>();
  for (const d of diagnostics) {
    if (!d.derived) continue;
    const key = d.blockedBy;
    const names = groups.get(key) ?? [];
    names.push(d.resource ?? "(unnamed)");
    groups.set(key, names);
  }
  return groups;
}

/** One collapsed line per blocked chain, e.g.
 *  `9 resources blocked by GrantDb: GrantStore, GoogleTokens, ...`. */
export function describeBlockedGroup(blockedBy: string | undefined, names: string[]): string {
  const subject = `${names.length} resource${names.length !== 1 ? "s" : ""}`;
  const blocker = blockedBy ?? "an uninitialized dependency";
  return `${subject} blocked by ${blocker}: ${names.join(", ")}`;
}

/** The headline for a classified failure set. Shared by the aggregate error's
 *  own message and by the entry an importing context builds for it, so the two
 *  are never recovered by re-parsing each other's rendered text. */
export function summarizeInitFailures(diagnostics: RuntimeDiagnostic[]): string {
  const total = diagnostics.length;
  const roots = diagnostics.filter((d) => !d.derived).length;
  const blocked = total - roots;
  return (
    `${total} resource${total !== 1 ? "s" : ""} failed to initialize` +
    (blocked > 0 ? ` (${roots} root cause${roots !== 1 ? "s" : ""}, rest blocked)` : "")
  );
}

/** Render a classified failure set as the text body of the aggregate error
 *  message — root causes in full, each blocked chain collapsed to one line.
 *  Nested children recurse through this same function so a child list is
 *  traversed exactly once, groups included. */
export function renderInitFailureText(diagnostics: RuntimeDiagnostic[]): string {
  const lines: string[] = [];
  for (const d of diagnostics) {
    if (!d.derived) {
      lines.push(
        `  ${d.kind ? `${d.kind} ` : ""}${d.resource}: ${d.message}${d.code ? ` [${d.code}]` : ""}`,
      );
      if (d.details) lines.push(...d.details.split("\n").map((l) => `    ${l}`));
    }
    // A derived entry contributes no line of its own, but a nested context's
    // root causes are not shadows of THIS context's failure — they still report.
    if (d.children?.length) {
      lines.push(
        ...renderInitFailureText(d.children)
          .split("\n")
          .map((l) => `  ${l}`),
      );
    }
  }
  for (const [blockedBy, names] of groupBlockedResources(diagnostics)) {
    lines.push(`  ${describeBlockedGroup(blockedBy, names)}`);
  }
  return lines.join("\n");
}
