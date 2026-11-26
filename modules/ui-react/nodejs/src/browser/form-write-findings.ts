import type { Binding } from "./bindings.js";
import { issuePlace, issueText, problemOf } from "./problem-details.js";
import type { Field } from "./record-fields.js";
import { findingText, type Say } from "./texts.js";
import type { Finding } from "./validation.js";

/** What a write refuses of a form's record: by the field it lands on, and the rest. */
export interface PlacedFindings {
  /** Each wording, by the property of the shown field it lands on. */
  byField: Record<string, string[]>;
  /** Every other finding, worded with its path, for the write's answer region. */
  other: string[];
}

/** The field an input of a write lands on: one bound to exactly `values.<property>` of a shown field. */
function fieldOf(inputs: Record<string, Binding>, input: string | undefined, shown: ReadonlySet<string>): string | undefined {
  if (input === undefined) return undefined;
  const binding = inputs[input];
  if (binding === undefined || !("root" in binding) || binding.root !== "values" || binding.path.length !== 1) return undefined;
  return shown.has(binding.path[0]) ? binding.path[0] : undefined;
}

function place(found: { input: string | undefined; field: string; whole: string }[], inputs: Record<string, Binding>, fields: Field[]): PlacedFindings {
  const shown = new Set(fields.map((field) => field.property));
  const placed: PlacedFindings = { byField: {}, other: [] };
  for (const { input, field, whole } of found) {
    const property = fieldOf(inputs, input, shown);
    if (property === undefined) placed.other.push(whole);
    else (placed.byField[property] ??= []).push(field);
  }
  return placed;
}

/**
 * Where what a write's input model refuses of the record its inputs bind
 * lands: on the field an input is bound to as exactly `values.<property>`,
 * else in the write's answer region.
 */
export function placedFindings(findings: Finding[], inputs: Record<string, Binding>, shown: Field[], say: Say): PlacedFindings {
  return place(
    findings.map((finding) => ({ input: finding.path[0], field: say(finding.text.key, finding.text.values), whole: findingText(finding, say) })),
    inputs,
    shown,
  );
}

/** A 400's issues for a write, by the same rule: an issue within the body lands on the field its input names, the rest in the answer region beside the failure tree. */
export function placedIssues(body: unknown, inputs: Record<string, Binding>, shown: Field[], say: Say): { byField: Record<string, string>; other: string[] } {
  const problem = problemOf(body);
  const found = problem.issues.map((issue) => {
    const { inBody, path } = issuePlace(issue);
    const text = issueText(issue);
    return { input: inBody ? path[0] : undefined, field: say(text.key, text.values), whole: findingText({ path, text }, say) };
  });
  const placed = place(found, inputs, shown);
  return { byField: Object.fromEntries(Object.entries(placed.byField).map(([property, messages]) => [property, messages[0]])), other: placed.other };
}
