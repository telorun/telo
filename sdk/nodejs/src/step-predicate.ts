import { ERR_PREDICATE_NOT_BOOLEAN } from "./contract-errors.js";
import { InvokeError } from "./invoke-error.js";

/**
 * A predicate's result, held to the one type a predicate has.
 *
 * Every predicate of the step grammar — a step's `when`, `if`, `elseif[].if`,
 * `while` — and every boot target's `when` is read here, so a decision is taken
 * on a boolean and nothing else. A string `"false"` is not false and not true:
 * reading it by truthiness ran a branch the author meant to skip, so any other
 * result is refused with `ERR_PREDICATE_NOT_BOOLEAN`, naming where the
 * predicate is written and what it produced.
 */
export function predicateResult(value: unknown, site: string): boolean {
  if (typeof value === "boolean") return value;
  const produced = describeProduced(value);
  throw new InvokeError(
    ERR_PREDICATE_NOT_BOOLEAN,
    `The predicate at '${site}' must evaluate to a boolean, but the expression produced ${produced}. ` +
      `A predicate is never coerced: compare explicitly (e.g. \`variables.flag == 'true'\`).`,
    { site, produced: typeName(value) },
  );
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "bigint") return "int";
  return typeof value === "object" ? "map" : typeof value;
}

function describeProduced(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (typeof value === "number" || typeof value === "bigint") return `the number ${String(value)}`;
  return `a ${typeName(value)}`;
}
