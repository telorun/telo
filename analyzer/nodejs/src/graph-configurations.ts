/**
 * The configurations an editor can draw a module in, and what a picked one
 * does to its graph.
 *
 * A module with choices (`!if` / `!switch` outside a template body) has one
 * graph per configuration: the dimensions its choices read, each with the
 * value a picker starts at, and for each picked assignment the choices'
 * alternatives and the one selected. A declaration-position choice stays ONE box
 * under its name — only its kind, the selected alternative's, follows the
 * pick — so selection and layout survive switching the picker.
 *
 * Browser-safe.
 */
import type { ExpansionSentinel } from "@telorun/templating";
import {
  branchValue,
  branchesOf,
  pathOf,
  type ChoiceReading,
  type ChoiceSite,
} from "./choice-reading.js";
import {
  ABSENT,
  memberOfValue,
  type Assignment,
  type Dimension,
} from "./configuration-dimensions.js";
import {
  ABSENT_ALTERNATIVE,
  type GraphAlternative,
  type GraphChoice,
  type ModuleGraph,
} from "./module-graph.js";

/** One axis of the picker: a key, its domain and the value it starts at. */
export interface GraphDimension {
  key: string;
  values: unknown[];
  default: unknown;
}

export interface GraphConfigurations {
  dimensions: GraphDimension[];
  /** The assignment a picker starts at: every dimension at its default. */
  default: Assignment;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A dimension's starting value: its declared `default:` (a presence
 *  dimension: absent), else the first value of its domain. */
function startingValue(dimension: Dimension): unknown {
  const first = dimension.values[0];
  if (dimension.projection === "presence") return dimension.values.includes(ABSENT) ? ABSENT : first;
  const declaration = dimension.declaration;
  if (!Object.hasOwn(declaration, "default")) return first;
  const declared =
    dimension.projection === "member"
      ? (memberOfValue(declaration, declaration.default, dimension.member!) ?? null)
      : declaration.default;
  return dimension.values.find((v) => sameValue(v, declared)) ?? first;
}

export function graphConfigurationsOf(dimensions: readonly Dimension[]): GraphConfigurations {
  const out = dimensions.map((d) => ({ key: d.key, values: [...d.values], default: startingValue(d) }));
  return {
    dimensions: out,
    default: Object.fromEntries(out.map((d) => [d.key, d.default])),
  };
}

/** The assignment a picker's choice completes to: every dimension the pick
 *  leaves out, or gives a value outside its domain, at its default. */
export function completeAssignment(configurations: GraphConfigurations, picked: Assignment | undefined): Assignment {
  const out: Record<string, unknown> = {};
  for (const dimension of configurations.dimensions) {
    const value = picked?.[dimension.key];
    out[dimension.key] =
      picked && Object.hasOwn(picked, dimension.key) && dimension.values.some((v) => sameValue(v, value))
        ? value
        : dimension.default;
  }
  return out;
}

function alternativesOf(site: ChoiceSite, declaration: boolean): GraphAlternative[] {
  const out: GraphAlternative[] = [];
  for (const [id] of branchesOf(site)) {
    const key = id.startsWith("case:") ? id.slice("case:".length) : id;
    const leaf = declaration ? declaredKind(branchValue(site.sentinel, id).value) : undefined;
    out.push({ key, ...(leaf ? { kind: leaf } : {}) });
  }
  if (site.tag === "if" && !out.some((a) => a.key === "else")) out.push({ key: ABSENT_ALTERNATIVE });
  return out;
}

/** The kind a branch declares, following a nested tag to its first. */
function declaredKind(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (typeof body.__expand === "string") {
    const nested = body.__expand === "if" ? [body.then, body.else] : [...Object.values((body.cases ?? {}) as object), body.default];
    for (const branch of nested) {
      const found = declaredKind(branch);
      if (found) return found;
    }
    return undefined;
  }
  return typeof body.kind === "string" ? body.kind : undefined;
}

/**
 * Mark the boxes of `graph` that a choice of the module writes: a
 * declaration-position choice on the box under its name, a choice in a field
 * on the box holding the field. `decisions` is what `assignment` selects.
 * Only an outermost choice is marked; one nested in a branch is part of it.
 */
export function annotateChoices(
  graph: ModuleGraph,
  reading: ChoiceReading,
  assignment: Assignment,
): void {
  const decisions = reading.decide(assignment);
  for (const site of reading.sites) {
    if (!site.own || site.parent) continue;
    const named = site.declaration
      ? (site.sentinel as { metadata?: { name?: unknown } }).metadata?.name
      : (site.holder.metadata as { name?: unknown } | undefined)?.name;
    if (typeof named !== "string") continue;
    const node = graph.nodes.find(
      (n) => n.name === named && !n.external && !n.root && (site.module === undefined || n.module === undefined || n.module === site.module),
    );
    if (!node) continue;
    const branch = decisions.get(site.sentinel as ExpansionSentinel);
    const choice: GraphChoice = {
      path: site.declaration ? "" : pathOf(site.keys),
      tag: site.tag,
      alternatives: alternativesOf(site, site.declaration),
      selected:
        typeof branch === "string" && !branch.startsWith("\0")
          ? branch.startsWith("case:")
            ? branch.slice("case:".length)
            : branch
          : site.tag === "if"
            ? ABSENT_ALTERNATIVE
            : null,
    };
    if (site.declaration) node.choice = choice;
    else (node.choices ??= []).push(choice);
  }
}
