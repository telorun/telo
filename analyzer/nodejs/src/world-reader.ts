/**
 * How a finding of a whole-application pass reads the world it is rendered and
 * placed in: whether a value of the world's logic holds there, and which
 * option of each choice is taken. Over the configurations a finding holds
 * under a condition, and what it says is split by the conditions its text and
 * its place read — never by configuration; in a branch no configuration takes,
 * the branch's own witness decides.
 *
 * Browser-safe.
 */
import { takenAt, type ChoiceDecider, type DeadBranchWorld, type Forcing } from "./conditioned-expansion.js";
import type { Assignment } from "./configuration-dimensions.js";
import { FALSE, type Condition, type ConditionSpace } from "./presence-condition.js";

export interface WorldReader<T> extends ChoiceDecider {
  holds(held: T): boolean;
}

/** A branch no configuration takes, as it is read: a configuration reaching
 *  its choice and the choices forced there. */
export interface DeadBranchRun {
  readonly baseline: Assignment;
  readonly forcing: Forcing;
  readonly world: DeadBranchWorld;
}

/**
 * `held` split by what `render` reads: each part holds where every condition
 * the render asks about answers alike, so what it renders there is one value.
 * A condition implied by the part read so far splits nothing.
 */
export function splitByReads<V>(
  space: ConditionSpace,
  held: Condition,
  render: (read: WorldReader<Condition>) => V,
): { readonly condition: Condition; readonly value: V }[] {
  const out: { condition: Condition; value: V }[] = [];
  let remaining = held;
  while (remaining !== FALSE) {
    const point = space.firstAssignment(remaining)!;
    let part = remaining;
    const holds = (condition: Condition): boolean => {
      const answer = space.holds(condition, point);
      part = space.and(part, answer ? condition : space.not(condition));
      return answer;
    };
    const value = render({ holds, taken: (element) => holds(element.condition) });
    out.push({ condition: part, value });
    remaining = space.and(remaining, space.not(part));
  }
  return out;
}

/** The reader of a branch no configuration takes: its world is one witness. */
export function deadBranchReader(space: ConditionSpace, run: DeadBranchRun): WorldReader<boolean> {
  return {
    holds: (held) => held,
    taken: (element) => takenAt(space, element.condition, element.path, run.baseline, run.forcing),
  };
}
