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

/** A state of the renderer's, as an element carries it. */
export interface PartState {
  attribute: string;
  value: string;
}

/** Properties a theme must not declare on a part, while it carries a state, or
 *  on any part carrying the state — at least one of `part` and `state` named —
 *  or on what stands in a relation to a part: any part holding a `holding`
 *  part as a child, or any part matching one of `interactive` after an `after`
 *  part, inside the element holding it. */
export interface Reservation {
  part?: string;
  state?: PartState;
  holding?: string;
  after?: string;
  interactive?: string[];
  properties: string[];
  because: string;
}

/** What a reservation in a relation to a part reaches, as a key the coverage records it under; none for any other. */
const relationOf = (reservation: Reservation): string | undefined =>
  reservation.holding !== undefined
    ? `holding ${reservation.holding}`
    : reservation.after !== undefined
      ? `after ${reservation.after} ${(reservation.interactive ?? []).join(", ")}`
      : undefined;

/** Whether an element is after an element carrying `part`, inside the element holding that one. */
const isAfter = (element: Element, part: string): boolean =>
  [...element.ownerDocument.querySelectorAll(`[data-telo-part="${part}"]`)].some(
    (before) => before !== element && !before.contains(element) && !!before.parentElement?.contains(element) && (before.compareDocumentPosition(element) & 4) !== 0,
  );

/** The elements a reservation in a relation to a part reaches in a document. */
function reachedBy(reservation: Reservation, document: Document): Set<Element> {
  const carriers = [...document.querySelectorAll("[data-telo-part]")];
  if (reservation.holding !== undefined) {
    const held = reservation.holding;
    return new Set(carriers.filter((carrier) => [...carrier.children].some((child) => child.getAttribute("data-telo-part") === held)));
  }
  const after = reservation.after as string;
  const interactive = (reservation.interactive ?? []).join(", ");
  return new Set(
    carriers.filter((carrier) => carrier.getAttribute("data-telo-part") !== after && interactive !== "" && carrier.matches(interactive) && isAfter(carrier, after)),
  );
}

/** What the style half is held to: the renderer's parts and the properties
 *  of them a theme must not declare. */
export interface StyleContract {
  parts: string[];
  reserved: Reservation[];
}

/**
 * Each property that also sets one of the reserved properties, in the
 * horizontal writing mode the renderer lays out in: a shorthand, or a logical
 * property standing for a physical one.
 */
const ALSO_SETS: Record<string, string[]> = {
  all: ["*"],
  overflow: ["overflow-x", "overflow-y"],
  padding: ["padding-inline"],
  "padding-left": ["padding-inline"],
  "padding-right": ["padding-inline"],
  "padding-inline-start": ["padding-inline"],
  "padding-inline-end": ["padding-inline"],
  margin: ["margin-inline", "margin-top", "margin-bottom"],
  "margin-block": ["margin-top", "margin-bottom"],
  "margin-block-start": ["margin-top"],
  "margin-block-end": ["margin-bottom"],
  "margin-left": ["margin-inline"],
  "margin-right": ["margin-inline"],
  "margin-inline-start": ["margin-inline"],
  "margin-inline-end": ["margin-inline"],
  "grid-area": ["grid-column"],
  "grid-column-start": ["grid-column"],
  "grid-column-end": ["grid-column"],
  flex: ["flex-grow", "flex-shrink", "flex-basis"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  "block-size": ["height"],
  "place-items": ["align-items"],
  "overflow-block": ["overflow-y"],
  "overflow-inline": ["overflow-x"],
  inset: ["top", "right", "bottom", "left"],
  "inset-block": ["top", "bottom"],
  "inset-block-end": ["bottom"],
  "min-block-size": ["min-height"],
  "max-inline-size": ["max-width"],
  grid: ["grid-template-columns", "grid-template-rows"],
  "grid-template": ["grid-template-columns", "grid-template-rows"],
  background: ["background-color"],
  mask: ["mask-image"],
  "-webkit-mask": ["mask-image"],
  "-webkit-mask-image": ["mask-image"],
};

const declares = (rule: StyleRule, property: string) =>
  rule.properties.some((declared) => declared === property || (ALSO_SETS[declared] ?? []).some((set) => set === "*" || set === property));

interface RuleCoverage {
  sheet: string;
  rule: StyleRule;
  /** The parts it matched in some snapshot. */
  parts: Set<string>;
  /** Each `data-` attribute value a part it matched carried, as `<attribute>=<value>`, with the parts carrying it. */
  states: Map<string, Set<string>>;
  /** Whether some part-carrying element of some snapshot is one it did not match. */
  missedAPart: boolean;
  /** By the key of a reservation in a relation to a part, the parts it reached that this rule matched. */
  related: Map<string, Set<string>>;
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
  private readonly relations: Reservation[];

  /** `reserved` names the reservations in a relation to a part that each snapshot is read for; the others need none. */
  constructor(sheets: readonly ReadStylesheet[], reserved: readonly Reservation[] = []) {
    this.rules = sheets.flatMap(({ path, reading }) =>
      reading.rules.map((rule) => ({ sheet: path, rule, parts: new Set<string>(), states: new Map<string, Set<string>>(), related: new Map<string, Set<string>>(), missedAPart: false })),
    );
    this.relations = reserved.filter((reservation) => relationOf(reservation) !== undefined);
  }

  /** Match every rule against the document as it stands. */
  record(document: Document): void {
    const carriers = [...document.querySelectorAll("[data-telo-part]")];
    if (carriers.length === 0) return;
    for (const carrier of carriers) this.drawn.add(carrier.getAttribute("data-telo-part") as string);
    const reached = this.relations.map((reservation) => ({ key: relationOf(reservation) as string, elements: reachedBy(reservation, document) }));
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
        if (!matched.has(carrier)) {
          coverage.missedAPart = true;
          continue;
        }
        const part = carrier.getAttribute("data-telo-part") as string;
        coverage.parts.add(part);
        for (const { key, elements } of reached) {
          if (!elements.has(carrier)) continue;
          const parts = coverage.related.get(key) ?? new Set<string>();
          parts.add(part);
          coverage.related.set(key, parts);
        }
        for (const { name, value } of carrier.attributes) {
          if (!name.startsWith("data-") || name === "data-telo-part") continue;
          const key = `${name}=${value}`;
          const carrying = coverage.states.get(key) ?? new Set<string>();
          carrying.add(part);
          coverage.states.set(key, carrying);
        }
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
    for (const reservation of contract.reserved) {
      const { part, state, holding, after, properties, because } = reservation;
      const relation = relationOf(reservation);
      const where = state === undefined ? undefined : `${state.attribute}="${state.value}"`;
      for (const property of properties) {
        for (const coverage of this.rules) {
          if (!declares(coverage.rule, property)) continue;
          // The parts the reservation reaches that this rule styled: those in its relation to a part, else the named
          // part — while it carried the state when one is named — else every part carrying the state.
          const carrying = state === undefined ? undefined : coverage.states.get(`${state.attribute}=${state.value}`);
          const reached =
            relation !== undefined
              ? [...(coverage.related.get(relation) ?? [])]
              : state === undefined
                ? coverage.parts.has(part as string)
                  ? [part as string]
                  : []
                : [...(carrying ?? [])].filter((each) => part === undefined || each === part);
          if (reached.length === 0) continue;
          const named = reached.map((each) => `'${each}'`).join(", ");
          const subject =
            holding !== undefined
              ? `holding ${holding}: ${property}`
              : after !== undefined
                ? `after ${after}: ${property}`
                : `${part ?? `[${where}]`}${part !== undefined && where !== undefined ? `[${where}]` : ""}: ${property}`;
          const key = `${subject}\n${coverage.sheet}\n${coverage.rule.written}`;
          if (reported.has(key)) continue;
          reported.add(key);
          const on =
            holding !== undefined
              ? `a part holding a '${holding}' (${named})`
              : after !== undefined
                ? `interactive content after a '${after}' (${named})`
                : where === undefined
                  ? `the '${part}' part`
                  : part === undefined
                    ? `a part carrying ${where} (${named})`
                    : `the '${part}' part while it carries ${where}`;
          problems.push({
            check: "property-reserved",
            subject,
            message: `'${coverage.rule.written}' in ${coverage.sheet} sets '${property}' on ${on}, which the renderer reserves: ${because}.`,
          });
        }
      }
    }
    return problems;
  }
}
