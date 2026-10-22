import type { Problem } from "./problem.js";
import type { StyleRule, StylesheetReading } from "./stylesheet-rules.js";

/** A stylesheet of the theme as the checks read it. */
export interface ReadStylesheet {
  /** Absolute path, for the messages. */
  path: string;
  reading: StylesheetReading;
}

export interface UnstyledPart {
  part: string;
  reason: string;
}

/** What the style half is held to: the renderer's parts and the properties
 *  of them a theme must not declare. */
export interface StyleContract {
  parts: string[];
  reserved: { part: string; properties: string[]; because: string }[];
}

/**
 * Each property that also sets one of the reserved properties, in the
 * horizontal writing mode the renderer lays out in: a shorthand, or a logical
 * property standing for a physical one.
 */
const ALSO_SETS: Record<string, string[]> = {
  all: ["*"],
  overflow: ["overflow-x", "overflow-y"],
  "overflow-block": ["overflow-y"],
  "overflow-inline": ["overflow-x"],
  inset: ["top", "right", "bottom", "left"],
  "inset-block": ["top", "bottom"],
  "inset-block-end": ["bottom"],
  "min-block-size": ["min-height"],
  grid: ["grid-template-columns"],
  "grid-template": ["grid-template-columns"],
};

const declares = (rule: StyleRule, property: string) =>
  rule.properties.some((declared) => declared === property || (ALSO_SETS[declared] ?? []).some((set) => set === "*" || set === property));

interface RuleCoverage {
  sheet: string;
  rule: StyleRule;
  /** The parts it matched in some snapshot. */
  parts: Set<string>;
  /** Whether some part-carrying element of some snapshot is one it did not match. */
  missedAPart: boolean;
  /** Set once the window could not match the selector. */
  unmatchable?: string;
}

/**
 * Which part each rule of a theme reaches, over every snapshot of every scene:
 * a rule counts for a part only where it tells that part apart from the rest,
 * so a rule on `*`, or on the attribute every part carries, styles nothing.
 */
export class StyleCoverage {
  private readonly rules: RuleCoverage[];
  private readonly drawn = new Set<string>();

  constructor(sheets: readonly ReadStylesheet[]) {
    this.rules = sheets.flatMap(({ path, reading }) =>
      reading.rules.map((rule) => ({ sheet: path, rule, parts: new Set<string>(), missedAPart: false })),
    );
  }

  /** Match every rule against the document as it stands. */
  record(document: Document): void {
    const carriers = [...document.querySelectorAll("[data-telo-part]")];
    if (carriers.length === 0) return;
    for (const carrier of carriers) this.drawn.add(carrier.getAttribute("data-telo-part") as string);
    for (const coverage of this.rules) {
      if (coverage.unmatchable !== undefined) continue;
      let matched: Set<Element>;
      try {
        matched = new Set(document.querySelectorAll(coverage.rule.matched));
      } catch (error) {
        coverage.unmatchable = error instanceof Error ? error.message : String(error);
        continue;
      }
      for (const carrier of carriers) {
        if (matched.has(carrier)) coverage.parts.add(carrier.getAttribute("data-telo-part") as string);
        else coverage.missedAPart = true;
      }
    }
  }

  /** The style problems, in the order of the checks: selectors the window
   *  could not match, unstyled parts, stale `unstyled` entries, reserved properties. */
  problems(contract: StyleContract, unstyled: readonly UnstyledPart[]): Problem[] {
    const problems: Problem[] = [];
    for (const coverage of this.rules) {
      if (coverage.unmatchable === undefined) continue;
      problems.push({
        check: "stylesheet-unparseable",
        subject: coverage.sheet,
        message: `The selector '${coverage.rule.written}' cannot be matched: ${coverage.unmatchable}`,
      });
    }
    const styledBy = new Map<string, RuleCoverage>();
    for (const coverage of this.rules) {
      if (!coverage.missedAPart) continue;
      for (const part of coverage.parts) if (!styledBy.has(part)) styledBy.set(part, coverage);
    }
    const listed = new Set(unstyled.map((entry) => entry.part));
    for (const part of contract.parts) {
      if (styledBy.has(part) || listed.has(part)) continue;
      problems.push({
        check: "part-unstyled",
        subject: part,
        message: this.drawn.has(part)
          ? `No rule of the theme styles the '${part}' part apart from the others. Style it, or list it in 'unstyled' with the reason.`
          : `No scene drew the '${part}' part under this theme's controls, so no rule of the theme was seen to style it.`,
      });
    }
    for (const { part } of unstyled) {
      if (!contract.parts.includes(part)) {
        problems.push({ check: "unstyled-stale", subject: part, message: `'unstyled' lists '${part}', which is no part the renderer draws. Remove it.` });
        continue;
      }
      const by = styledBy.get(part);
      if (by) {
        problems.push({
          check: "unstyled-stale",
          subject: part,
          message: `'unstyled' lists '${part}', but the theme styles it ('${by.rule.written}' in ${by.sheet}). Remove it from 'unstyled'.`,
        });
      }
    }
    const reported = new Set<string>();
    for (const { part, properties, because } of contract.reserved) {
      for (const property of properties) {
        for (const coverage of this.rules) {
          if (!coverage.parts.has(part) || !declares(coverage.rule, property)) continue;
          const key = `${part}\n${property}\n${coverage.sheet}\n${coverage.rule.written}`;
          if (reported.has(key)) continue;
          reported.add(key);
          problems.push({
            check: "property-reserved",
            subject: `${part}: ${property}`,
            message: `'${coverage.rule.written}' in ${coverage.sheet} sets '${property}' on the '${part}' part, which the renderer reserves: ${because}.`,
          });
        }
      }
    }
    return problems;
  }
}
