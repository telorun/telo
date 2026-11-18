/**
 * `RETHROW_WITHOUT_CAUGHT_ERROR` over every configuration at once: each
 * `rethrow:` step of the conditioned call graph judged once by the one rule
 * (`rethrowPlacement`), in the raw form a run's own finding takes, about the
 * step's owner — placement moves it to where it is written; in a branch no
 * configuration takes, the steps the branch holds.
 *
 * Browser-safe.
 */
import type { ConditionedCallGraph, HeldAt, HeldGraphNode } from "./conditioned-call-graph.js";
import type { ChoiceDecider } from "./conditioned-expansion.js";
import type { ResourceGraphNode, StepGraphNode } from "./call-graph.js";
import { aboutDeclaration } from "./placement.js";
import type { AnalysisDiagnostic } from "./types.js";
import { readDeadBranches, type PassTable } from "./union-passes.js";
import type { rethrowPlacement } from "./validate-rethrow-placement.js";
import type { DeadBranchRun } from "./world-reader.js";

interface Entry extends HeldAt {
  readonly step: HeldGraphNode;
  readonly owner: string;
}

export function rethrowFindings(
  graph: ConditionedCallGraph,
  placement: ReturnType<typeof rethrowPlacement>,
  deadBranches: readonly DeadBranchRun[],
): PassTable {
  const { space } = graph;
  const entries: Entry[] = [];
  for (const step of graph.nodes) {
    if (step.node.type !== "step" || step.owner === undefined) continue;
    const owner = graph.node(step.owner);
    if (!owner || owner.node.type !== "resource") continue;
    const resource = owner.node as ResourceGraphNode;
    if (!placement.reported(resource)) continue;
    const written = step.node as StepGraphNode;
    // Where the step stands decides the rule, never the index it is held at.
    if (!placement.issue(resource, { path: written.path, ...(written.name ? { name: written.name } : {}) })) continue;
    for (const holdings of graph.memberHoldings(step, "rethrow")) {
      const condition = holdings.reduce((held, h) => space.and(held, h.condition), step.condition);
      entries.push({ step, owner: step.owner, condition, holdings: [...step.holdings, ...holdings] });
    }
  }

  const render = (entry: Entry, read: ChoiceDecider): AnalysisDiagnostic[] => {
    const owner = graph.identityBy(entry.owner, read);
    const path = graph.relativePathBy(entry.owner, entry.step.keys, read);
    const name = (entry.step.node as StepGraphNode).name;
    const found = placement.issue(owner, { path, ...(name ? { name } : {}) });
    if (!found) return [];
    return [aboutDeclaration(found, entry.owner)];
  };

  return {
    found: entries.map((entry) => ({ held: entry.condition, render: (read) => render(entry, read) })),
    dead: readDeadBranches("rethrowPlacement", deadBranches, (branch) => {
      const witness = branch.world;
      return entries
        .filter((entry) => graph.holdsAt(entry, witness))
        .map((entry) => ({ branch, render: (read: ChoiceDecider) => render(entry, read) }));
    }),
  };
}
