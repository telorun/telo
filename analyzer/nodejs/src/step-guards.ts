/**
 * The guards of the shared step grammar that enclose a CEL site — the reader of
 * "what held on the way here", handed to the checker as assumptions.
 *
 * Read off the `Step` fragment's own field names, which are constants of that
 * grammar (`step-slot.ts`), never off a kind: `if:` holds over `then:` and fails
 * over each `elseif:` (its `if:` included) and `else:`; an `elseif:`'s `if:` holds
 * over its `then:`; `while:` over `do:`; a `switch:` makes `<switch> == '<case>'`
 * hold over the case and `<switch> in [<cases>]` fail over `default:` (only where
 * the subject checks as `string`, which the caller decides); a `try` step's
 * `when:` holds over `try:`, `catch:` and `finally:`; an invoke step's `when:`
 * over its own `inputs:`. A guard reaches every site of the steps in the lists it
 * guards, at any depth, and no inline declaration, `with:` member, dispatched
 * body or later step.
 *
 * Browser-safe: no Node built-ins.
 */

import { emittedStepIdentity } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import { manifestFragmentOf } from "./manifest-schemas.js";
import { STEP_FRAGMENT } from "./step-slot.js";

/** One guard on the way to a site, outermost first. */
export interface StepGuard {
  /** The condition's CEL source. */
  readonly condition: string;
  /** Whether it held on the way to the site. */
  readonly holds: boolean;
  /** A `switch:` case's subject: the guard stands only where it checks as `string`. */
  readonly switchSubject?: string;
  /** Chains that may denote another value at the site than where the guard was tested. */
  readonly rebound: readonly string[];
  /** Where the guard is written, from the step field's holder. */
  readonly at: string;
}

/** The guards enclosing a site. */
export interface StepGuards {
  readonly guards: readonly StepGuard[];
}

/**
 * The only roots a guard's proof survives over: a resumed run restores `steps`
 * and `inputs`, while every other root may read differently at the site.
 */
export const STEP_GUARD_KEPT_ROOTS: ReadonlySet<string> = new Set(["steps", "inputs"]);

/** A guard as the walk finds it, before what the site's own path rebinds is known. */
interface PendingGuard {
  condition: string;
  holds: boolean;
  switchSubject?: string;
  at: string;
  guarded: unknown[];
  rebound: Set<string>;
}

/** The fields of a step that guard the branches below it. */
export const STEP_GUARD_FIELDS: readonly string[] = ["if", "while", "switch", "when"];
/** The fields of a step a guard reaches. */
export const STEP_GUARDED_BRANCHES: ReadonlySet<string> = new Set([
  "then", "else", "elseif", "do", "cases", "default", "try", "catch", "finally", "inputs",
]);

/** The `steps` record is republished between steps, so every proof on a reading is rebound. */
const ALWAYS_REBOUND = "resources";
/** The binding an error-context region puts in scope. */
const ERROR_BINDING = "error";

/**
 * The guards enclosing `path` of `manifest`, whose kind's schema is `schema`;
 * undefined where `path` is in no step body of the shared grammar, or crosses a
 * declaration nested in one. `errorFields` are the branch fields that bind
 * `error` afresh (the kind's `x-telo-error-context` fields).
 */
export function stepGuardsAt(
  manifest: Record<string, any>,
  schema: Record<string, any> | undefined,
  path: string,
  errorFields: ReadonlySet<string>,
): StepGuards | undefined {
  const tokens = pathTokens(path);
  const field = tokens[0];
  if (typeof field !== "string") return undefined;
  const fieldSchema = schema?.properties?.[field] as Record<string, any> | undefined;
  if (!fieldSchema || fieldSchema["x-telo-step-context"] !== undefined) return undefined;
  if (manifestFragmentOf(fieldSchema.items) !== STEP_FRAGMENT) return undefined;

  const guards: PendingGuard[] = [];
  const guard = (value: unknown, holds: boolean, at: string, guarded: unknown[]): void => {
    const condition = celSource(value);
    if (condition !== undefined) guards.push({ condition, holds, at, guarded, rebound: new Set() });
  };

  let list: unknown = manifest[field];
  let at = field;
  let i = 1;
  for (;;) {
    const index = tokens[i];
    if (!Array.isArray(list) || typeof index !== "number") break;
    const step = list[index];
    if (!isRecord(step)) break;
    const stepAt = `${at}[${index}]`;
    const key = tokens[i + 1];
    if (typeof key !== "string") break;
    // What a step dispatches — an inline declaration above all — is no site of this body.
    if (key === "invoke" || typeof step.kind === "string") return undefined;
    let next: unknown;
    let nextAt: string;
    let consumed = 2;
    if (key === "inputs" && "invoke" in step) {
      guard(step.when, true, `${stepAt}.when`, []);
      break;
    } else if ((key === "then" || key === "else" || key === "elseif") && "if" in step) {
      const elseifs: unknown[] = Array.isArray(step.elseif) ? step.elseif : [];
      const branchesAfter = (from: number): unknown[] => [
        ...elseifs.slice(from).map((entry) => (isRecord(entry) ? entry.then : undefined)),
        step.else,
      ];
      if (key === "then") {
        guard(step.if, true, `${stepAt}.if`, [step.then]);
        next = step.then;
        nextAt = `${stepAt}.then`;
      } else {
        guard(step.if, false, `${stepAt}.if`, branchesAfter(0));
        const stop = key === "else" ? elseifs.length : tokens[i + 2];
        if (typeof stop !== "number") break;
        for (let k = 0; k < stop && k < elseifs.length; k++) {
          const entry = elseifs[k];
          if (isRecord(entry)) guard(entry.if, false, `${stepAt}.elseif[${k}].if`, branchesAfter(k + 1));
        }
        if (key === "else") {
          next = step.else;
          nextAt = `${stepAt}.else`;
        } else {
          const entry = elseifs[stop];
          if (!isRecord(entry) || tokens[i + 3] !== "then") break;
          guard(entry.if, true, `${stepAt}.elseif[${stop}].if`, [entry.then]);
          next = entry.then;
          nextAt = `${stepAt}.elseif[${stop}].then`;
          consumed = 4;
        }
      }
    } else if (key === "do" && "while" in step) {
      guard(step.while, true, `${stepAt}.while`, [step.do]);
      next = step.do;
      nextAt = `${stepAt}.do`;
    } else if ((key === "cases" || key === "default") && "switch" in step) {
      const subject = celSource(step.switch);
      const cases = isRecord(step.cases) ? step.cases : {};
      if (key === "cases") {
        const name = tokens[i + 2];
        if (typeof name !== "string" || !(name in cases)) break;
        if (subject !== undefined) {
          guards.push({
            condition: `(${subject}) == ${JSON.stringify(name)}`,
            holds: true,
            switchSubject: subject,
            at: `${stepAt}.switch`,
            guarded: [cases[name]],
            rebound: new Set(),
          });
        }
        next = cases[name];
        nextAt = `${stepAt}.cases.${name}`;
        consumed = 3;
      } else {
        const names = Object.keys(cases);
        if (subject !== undefined && names.length > 0) {
          guards.push({
            condition: `(${subject}) in [${names.map((name) => JSON.stringify(name)).join(", ")}]`,
            holds: false,
            switchSubject: subject,
            at: `${stepAt}.switch`,
            guarded: [step.default],
            rebound: new Set(),
          });
        }
        next = step.default;
        nextAt = `${stepAt}.default`;
      }
    } else if ((key === "try" || key === "catch" || key === "finally") && "try" in step) {
      guard(step.when, true, `${stepAt}.when`, [step.try, step.catch, step.finally]);
      next = step[key];
      nextAt = `${stepAt}.${key}`;
    } else {
      break;
    }
    // A branch binding the caught failure afresh rebinds it for every guard outside it.
    if (errorFields.has(key)) for (const each of guards) each.rebound.add(ERROR_BINDING);
    list = next;
    at = nextAt;
    i += consumed;
  }

  return {
    guards: guards.map((each) => ({
      condition: each.condition,
      holds: each.holds,
      ...(each.switchSubject !== undefined ? { switchSubject: each.switchSubject } : {}),
      rebound: [ALWAYS_REBOUND, ...[...stepNamesIn(each.guarded)].map((name) => `steps.${name}`), ...each.rebound],
      at: each.at,
    })),
  };
}

/** Every step name written in `lists`, at any depth of the grammar's branches. */
function stepNamesIn(lists: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  const pending = [...lists];
  while (pending.length > 0) {
    const list = pending.pop();
    if (!Array.isArray(list)) continue;
    for (const step of list) {
      if (!isRecord(step)) continue;
      const emitted = emittedStepIdentity(step);
      if (emitted && "repeat" in emitted) names.add(emitted.repeat);
      else if (typeof step.name === "string") names.add(step.name);
      pending.push(step.then, step.else, step.do, step.default, step.try, step.catch, step.finally);
      if (Array.isArray(step.elseif)) for (const entry of step.elseif) if (isRecord(entry)) pending.push(entry.then);
      if (isRecord(step.cases)) pending.push(...Object.values(step.cases));
    }
  }
  return names;
}

function celSource(value: unknown): string | undefined {
  return isTaggedSentinel(value) && value.engine === "cel" ? value.source : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A site path's keys: a bracketed index a number, every other segment its name. */
function pathTokens(path: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  for (const match of path.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    tokens.push(match[1] !== undefined ? Number(match[1]) : match[2]!);
  }
  return tokens;
}
