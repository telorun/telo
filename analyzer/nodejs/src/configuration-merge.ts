/**
 * The one place an analysis over several configurations becomes one list of
 * diagnostics. Each finding enters with the condition it holds in — a site's
 * key's, or the configuration a run found it in; one holding in every
 * configuration is reported as it is, any other carries `data.configurations`
 * — the partial assignments covering where it holds — and its message ends
 * with the smallest description of them (`(when variables.dialect is
 * postgres)`); one found only inside a branch no configuration takes carries
 * the empty list, and its description says so. Identity is the code, the place
 * (after relocation) and the message, so one defect found under several
 * conditions is reported once, under their union.
 *
 * Browser-safe.
 */
import type { ConfigurationDiagnostic } from "./choice-reading.js";
import {
  assignmentKey,
  describeBlocks,
  entriesOfBlocks,
  type Assignment,
  type Dimension,
} from "./configuration-dimensions.js";
import { ConditionSpace, FALSE, type Condition } from "./presence-condition.js";
import type { AnalysisDiagnostic } from "./types.js";

/** What one configuration's analysis found. */
export interface ConfigurationRun {
  readonly assignment: Assignment;
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

/** A finding and every configuration it holds in. */
export interface ConditionedFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly condition: Condition;
}

function identityOf(d: AnalysisDiagnostic): string {
  const data = d.data as
    | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
    | undefined;
  return JSON.stringify([
    d.code,
    data?.resource?.kind,
    data?.resource?.name,
    data?.filePath,
    data?.path,
    d.range ?? null,
    d.message,
  ]);
}

/** `findings`, in the order each first appears, merged by identity and
 *  labelled among the configurations `universe` holds. */
export function mergeConditionedDiagnostics(
  findings: Iterable<ConditionedFinding>,
  space: ConditionSpace,
  universe: Condition,
  dimensions: readonly Dimension[],
): AnalysisDiagnostic[] {
  const found = new Map<string, { diagnostic: AnalysisDiagnostic; condition: Condition }>();
  for (const { diagnostic, condition } of findings) {
    const identity = identityOf(diagnostic);
    const known = found.get(identity);
    if (known) known.condition = space.or(known.condition, condition);
    else found.set(identity, { diagnostic, condition });
  }
  const out: AnalysisDiagnostic[] = [];
  for (const { diagnostic, condition } of found.values()) {
    const held = space.and(condition, universe);
    if (held === universe) {
      out.push(diagnostic);
      continue;
    }
    const blocks = held === FALSE ? [] : space.cover(held, universe);
    const label = held === FALSE ? "(in a branch no configuration takes)" : describeBlocks(blocks, dimensions);
    out.push({
      ...diagnostic,
      message: label ? `${diagnostic.message} ${label}` : diagnostic.message,
      data: {
        ...((diagnostic.data as Record<string, unknown> | undefined) ?? {}),
        configurations: entriesOfBlocks(blocks),
      },
    });
  }
  return out;
}

/** {@link mergeConditionedDiagnostics} over runs and findings credited to
 *  sets of configurations (by {@link assignmentKey}; none given, every one). */
export function mergeConfigurationDiagnostics(
  runs: readonly ConfigurationRun[],
  extra: readonly ConfigurationDiagnostic[],
  dimensions: readonly Dimension[],
  configurations: readonly Assignment[],
): AnalysisDiagnostic[] {
  const space = new ConditionSpace(dimensions);
  const byKey = new Map(configurations.map((a) => [assignmentKey(a), space.assignment(a)]));
  const universe = space.some(byKey.values());
  const findings: ConditionedFinding[] = [];
  for (const run of runs) {
    const condition = space.assignment(run.assignment);
    for (const diagnostic of run.diagnostics) findings.push({ diagnostic, condition });
  }
  for (const { diagnostic, configurations: keys } of extra) {
    findings.push({
      diagnostic,
      condition: keys ? space.some([...keys].map((key) => byKey.get(key) ?? FALSE)) : universe,
    });
  }
  return mergeConditionedDiagnostics(findings, space, universe, dimensions);
}
