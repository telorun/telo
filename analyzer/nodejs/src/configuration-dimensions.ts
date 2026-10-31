/**
 * Dimensions and configurations: what a module's inputs contribute to the set
 * of ways an application can start, and how a set of those ways is described.
 *
 * A DIMENSION is a projection of a module input whose domain its declaration
 * closes — the whole value of a `variables:` entry declared `enum`, `const` or
 * `type: boolean`; a member bound by a value type's argument to an `enum` /
 * `const` schema (`secrets.databaseUrl.scheme`); the presence of an entry
 * declaring `default: null`. It is keyed by the path it is read at. A need is
 * one too, keyed by its need path whoever reads it ({@link needDimensionKey}):
 * an optional need's presence, and a member its type's field binds to an
 * `enum` / `const` argument. A CONFIGURATION assigns a value to every
 * dimension; the set is their product.
 *
 * Browser-safe.
 */
import { membersSlotOf, readMembersValue } from "./members-value-slot.js";
import { ConditionSpace, type ConditionBlock } from "./presence-condition.js";
import type { InputBlock, InputRead, ReadBlock } from "./decision-reads.js";

/** One dimension, keyed by the path it is read at. */
export interface Dimension {
  readonly key: string;
  /** `resources` for a need, whose `name` is its need path, `.`-joined. */
  readonly input: ReadBlock;
  readonly name: string;
  readonly projection: "whole" | "member" | "presence";
  /** A need's field whose member a `member` dimension is. */
  readonly field?: string;
  readonly member?: string;
  /** A need's path in the need table. */
  readonly needPath?: readonly string[];
  /** Its domain as JSON values: a presence dimension's are `present` /
   *  `absent`; a whole or member dimension of an input admitting absence holds
   *  `null` for the input's absence. */
  readonly values: readonly unknown[];
  /** The input's declaration: what types each value. */
  readonly declaration: Record<string, unknown>;
}

/** One assignment of a value to every dimension, by key. */
export type Assignment = Readonly<Record<string, unknown>>;

export const PRESENT = "present";
export const ABSENT = "absent";

/**
 * The key of a need's dimension — the ONE rule from a need path (the need
 * table's, which its environment names derive from) to a key: `resources.` and
 * the path, `.`-joined, and for a field's member the field and the member after
 * it. A root need's key is the path it is read at.
 */
export function needDimensionKey(path: readonly string[], field?: string, member?: string): string {
  return ["resources", ...path, ...(field !== undefined && member !== undefined ? [field, member] : [])].join(".");
}

/** True when an input's declaration admits absence: `default: null`. */
export function admitsAbsence(entry: Record<string, unknown>): boolean {
  return Object.hasOwn(entry, "default") && entry.default === null;
}

/** The values a whole-value dimension ranges over, or undefined when the
 *  declaration leaves the domain open. Only a `variables:` entry is one. */
export function wholeDomain(input: InputBlock, entry: Record<string, unknown>): unknown[] | undefined {
  if (input !== "variables") return undefined;
  if (Array.isArray(entry.enum)) return [...entry.enum];
  if (Object.hasOwn(entry, "const")) return [entry.const];
  if (entry.type === "boolean") return [false, true];
  return undefined;
}

/** The values a member dimension ranges over: the `enum` / `const` a value
 *  type's argument binds to that member at this declaration. */
export function memberDomain(entry: Record<string, unknown>, member: string): unknown[] | undefined {
  const slot = membersSlotOf(entry);
  if (!slot) return undefined;
  const parameter = slot.entry.parameters.find((p) => (p as { member?: string }).member === member);
  if (!parameter) return undefined;
  const argument = slot.args[parameter.name] as Record<string, unknown> | undefined;
  if (!argument || typeof argument !== "object") return undefined;
  if (Array.isArray(argument.enum)) return [...argument.enum];
  if (Object.hasOwn(argument, "const")) return [argument.const];
  return undefined;
}

/** How a root module's input read stands: a dimension (by key), a value
 *  constant in every configuration, or open. */
export type RootReading =
  | { readonly kind: "dimension"; readonly dimension: Dimension }
  | { readonly kind: "constant"; readonly value: unknown }
  | { readonly kind: "open"; readonly reason: string };

/**
 * What `read` amounts to in a module whose inputs are its own (the analysed
 * root), against the declaration `entry` (undefined when it declares none).
 * `projections` is every projection the module's decisions read the input
 * through, so presence and a whole or member dimension of one input share one
 * key.
 */
export function readRootInput(
  read: InputRead,
  entry: Record<string, unknown> | undefined,
  projections: ReadonlySet<string>,
): RootReading {
  const path = `${read.input}.${read.name}`;
  const input = read.input as InputBlock;
  if (!entry || typeof entry !== "object") {
    return { kind: "open", reason: `'${path}' is not declared by this module` };
  }
  const absent = admitsAbsence(entry);
  const withAbsence = (values: unknown[]) => (absent ? [...values, null] : values);
  const whole = wholeDomain(input, entry);
  if (read.projection === "whole") {
    if (!whole) {
      return {
        kind: "open",
        reason:
          read.input === "secrets"
            ? `a secret's whole value is never decided before boot`
            : `'${path}' is not declared 'enum', 'const' or 'type: boolean', so its value is open`,
      };
    }
    return {
      kind: "dimension",
      dimension: { key: path, input, name: read.name, projection: "whole", values: withAbsence(whole), declaration: entry },
    };
  }
  if (read.projection === "member") {
    const domain = memberDomain(entry, read.member!);
    if (!domain) {
      return {
        kind: "open",
        reason: `'${path}.${read.member}' is not a member its declaration binds to an 'enum' or 'const' argument`,
      };
    }
    return {
      kind: "dimension",
      dimension: {
        key: `${path}.${read.member}`,
        input,
        name: read.name,
        projection: "member",
        member: read.member!,
        values: withAbsence(domain),
        declaration: entry,
      },
    };
  }
  // Presence.
  if (!absent) return { kind: "constant", value: PRESENT };
  // Read beside the input's whole value or a member, absence is that
  // dimension's `null`.
  if (whole && projections.has("whole")) {
    return {
      kind: "dimension",
      dimension: { key: path, input, name: read.name, projection: "whole", values: withAbsence(whole), declaration: entry },
    };
  }
  for (const projection of projections) {
    if (!projection.startsWith("member:")) continue;
    const member = projection.slice("member:".length);
    const domain = memberDomain(entry, member);
    if (!domain) continue;
    return {
      kind: "dimension",
      dimension: {
        key: `${path}.${member}`,
        input,
        name: read.name,
        projection: "member",
        member,
        values: withAbsence(domain),
        declaration: entry,
      },
    };
  }
  return {
    kind: "dimension",
    dimension: { key: path, input, name: read.name, projection: "presence", values: [PRESENT, ABSENT], declaration: entry },
  };
}

/** The need a `resources.<name>` read reaches whatever reads it: the need the
 *  environment (an Application's) or the importer (a Library's) is read for —
 *  the outermost one of a whole-forward chain — its path, whether it is
 *  optional, and the field schemas of its type. */
export interface ReachedNeed {
  readonly path: readonly string[];
  readonly optional: boolean;
  readonly fields: Readonly<Record<string, Record<string, unknown>>>;
}

/**
 * What a `resources.<name>` read of a need amounts to, against the need it
 * reaches. `projections` is every projection the decisions read that need
 * through, so its presence and a member of one of its fields share one key, as
 * an input's do. A required need is present in every configuration.
 */
export function readNeedInput(read: InputRead, need: ReachedNeed, projections: ReadonlySet<string>): RootReading {
  const path = need.path.join(".");
  const withAbsence = (values: unknown[]) => (need.optional ? [...values, null] : values);
  const memberDimension = (field: string, member: string): Dimension | undefined => {
    const schema = need.fields[field];
    const domain = schema ? memberDomain(schema, member) : undefined;
    if (!domain) return undefined;
    return {
      key: needDimensionKey(need.path, field, member),
      input: "resources",
      name: path,
      projection: "member",
      field,
      member,
      needPath: need.path,
      values: withAbsence(domain),
      declaration: schema!,
    };
  };
  if (read.projection === "member") {
    const dimension = memberDimension(read.field!, read.member!);
    return dimension
      ? { kind: "dimension", dimension }
      : {
          kind: "open",
          reason:
            `'${read.chain}' is not a member the need type's field '${read.field}' binds to an 'enum' or ` +
            `'const' argument`,
        };
  }
  if (read.projection !== "presence") return { kind: "open", reason: `it reads '${read.chain}', which is not known before boot` };
  if (!need.optional) return { kind: "constant", value: PRESENT };
  // Read beside a member of one of its fields, absence is that dimension's `null`.
  for (const projection of projections) {
    if (!projection.startsWith("member:")) continue;
    const [field, member] = projection.slice("member:".length).split(".");
    const dimension = memberDimension(field!, member!);
    if (dimension) return { kind: "dimension", dimension };
  }
  return {
    kind: "dimension",
    dimension: {
      key: needDimensionKey(need.path),
      input: "resources",
      name: path,
      projection: "presence",
      needPath: need.path,
      values: [PRESENT, ABSENT],
      declaration: {},
    },
  };
}

/** The projection name a read is collected under, for {@link readRootInput}
 *  and {@link readNeedInput}. */
export function projectionName(read: InputRead): string {
  if (read.projection !== "member") return read.projection;
  return read.field !== undefined ? `member:${read.field}.${read.member}` : `member:${read.member}`;
}

/** Every configuration of `dimensions`: their product, with the member
 *  dimensions of one input agreeing on its absence. */
export function enumerateConfigurations(dimensions: readonly Dimension[]): Assignment[] {
  let out: Record<string, unknown>[] = [{}];
  for (const dimension of dimensions) {
    const next: Record<string, unknown>[] = [];
    for (const partial of out) {
      for (const value of dimension.values) next.push({ ...partial, [dimension.key]: value });
    }
    out = next;
  }
  const byInput = new Map<string, Dimension[]>();
  for (const dimension of dimensions) {
    if (dimension.projection !== "member") continue;
    const key = `${dimension.input}.${dimension.name}`;
    byInput.set(key, [...(byInput.get(key) ?? []), dimension]);
  }
  const groups = [...byInput.values()].filter((group) => group.length > 1);
  if (groups.length === 0) return out;
  return out.filter((assignment) =>
    groups.every((group) => {
      const nulls = group.filter((d) => assignment[d.key] === null).length;
      return nulls === 0 || nulls === group.length;
    }),
  );
}

/** A stable identity for an assignment. */
export function assignmentKey(assignment: Assignment): string {
  return JSON.stringify(Object.keys(assignment).sort().map((key) => [key, assignment[key]]));
}

function describeValue(dimension: Dimension, value: unknown): string {
  if (value === null) return `${dimension.input}.${dimension.name} is absent`;
  if (typeof value === "string") return `${dimension.key} is ${value}`;
  return `${dimension.key} is ${JSON.stringify(value)}`;
}

/**
 * The smallest description of `subset` among `all` (both lists of
 * assignments over `dimensions`): `(when variables.dialect is postgres)`. A
 * dimension every one of whose values the subset holds is omitted. Several
 * conjunctions are joined with `; or when`. The empty set is a finding inside
 * a branch no configuration takes, and says so.
 */
export function describeConfigurations(
  subset: readonly Assignment[],
  all: readonly Assignment[],
  dimensions: readonly Dimension[],
): string {
  if (subset.length === 0) return "(in a branch no configuration takes)";
  return describeBlocks(smallestBlocks(subset, all, dimensions), dimensions);
}

/** The label of a cover ({@link ConditionSpace.cover}) over `dimensions`. */
export function describeBlocks(blocks: readonly ConditionBlock[], dimensions: readonly Dimension[]): string {
  const clauses: string[] = [];
  for (const block of blocks) {
    const parts: string[] = [];
    for (const dimension of dimensions) {
      const values = block.get(dimension.key);
      if (!values) continue;
      if (values.length === 1) {
        parts.push(describeValue(dimension, values[0]));
      } else {
        const named = values.filter((v) => v !== null).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
        const absent = values.includes(null);
        parts.push(
          `${dimension.key} is ${named.join(" or ")}${absent ? ` (or ${dimension.input}.${dimension.name} is absent)` : ""}`,
        );
      }
    }
    if (parts.length > 0) clauses.push(parts.join(" and "));
  }
  return clauses.length === 0 ? "" : `(when ${clauses.join("; or when ")})`;
}

/**
 * `subset` as the cover of its condition among `all` — the configurations
 * outside `all` free — each block the values it holds per dimension, a
 * dimension every one of whose values it holds left out. Empty when `subset`
 * is.
 */
export function smallestBlocks(
  subset: readonly Assignment[],
  all: readonly Assignment[],
  dimensions: readonly Dimension[],
): ConditionBlock[] {
  const space = new ConditionSpace(dimensions);
  return space.cover(
    space.some(subset.map((a) => space.assignment(a))),
    space.some(all.map((a) => space.assignment(a))),
  );
}

/**
 * `subset` as the assignments it is required in, the way `requiredWhen`
 * reports it: a list of partial assignments, each naming only the dimensions
 * that narrow it — undefined when `subset` is every configuration, empty when
 * it is none.
 */
export function requiredWhenOf(
  subset: readonly Assignment[],
  all: readonly Assignment[],
  dimensions: readonly Dimension[],
): Assignment[] | undefined {
  if (subset.length === all.length) return undefined;
  return entriesOfBlocks(smallestBlocks(subset, all, dimensions));
}

/**
 * A cover's blocks as the partial assignments the wire carries
 * (`data.configurations`, `requiredWhen`): one entry per block, naming only the
 * dimensions the block narrows, each to one value — a block holding several
 * values of a dimension is an entry per value, since an entry's value is a
 * dimension's own JSON value and a list could not be told from one.
 */
export function entriesOfBlocks(blocks: readonly ConditionBlock[]): Assignment[] {
  const out: Assignment[] = [];
  for (const block of blocks) {
    let partials: Record<string, unknown>[] = [{}];
    for (const [key, values] of block) {
      partials = partials.flatMap((partial) => values.map((value) => ({ ...partial, [key]: value })));
    }
    out.push(...partials);
  }
  return out;
}

/** Whether `entry` — a partial assignment — agrees with `assignment` on every
 *  key it names; an entry naming none holds in every assignment. */
export function agreesWith(entry: Assignment, assignment: Assignment): boolean {
  return Object.entries(entry).every(([key, value]) => {
    const held = assignment[key];
    return held === value || JSON.stringify(held) === JSON.stringify(value);
  });
}

/**
 * The activation `variables` / `secrets` a root module's decisions are
 * evaluated with in one configuration: each dimension's value at its input,
 * an integer declared `type: integer` as an int64.
 */
export function rootInputValues(
  dimensions: readonly Dimension[],
  assignment: Assignment,
): { variables: Record<string, unknown>; secrets: Record<string, unknown> } {
  const out = { variables: {} as Record<string, unknown>, secrets: {} as Record<string, unknown> };
  for (const dimension of dimensions) {
    if (dimension.input === "resources") continue;
    const block = out[dimension.input];
    const value = assignment[dimension.key];
    if (dimension.projection === "presence") {
      block[dimension.name] = value === ABSENT ? null : {};
    } else if (dimension.projection === "whole") {
      block[dimension.name] = asDeclared(value, dimension.declaration);
    } else if (value === null) {
      block[dimension.name] = null;
    } else if (block[dimension.name] !== null) {
      block[dimension.name] = { ...((block[dimension.name] as object | undefined) ?? {}), [dimension.member!]: value };
    }
  }
  return out;
}

/** The value of `member` in a value of the members type `declaration` holds —
 *  text read through its plain encoding, an object of members built — or
 *  undefined when the value is none. */
export function memberOfValue(
  declaration: Record<string, unknown>,
  value: unknown,
  member: string,
): unknown {
  const slot = membersSlotOf(declaration);
  if (!slot || value === null || value === undefined) return undefined;
  const read = readMembersValue(slot, value);
  if (!("value" in read)) return undefined;
  const built = read.value as Record<string, unknown> | null;
  return built && typeof built === "object" ? (built[member] ?? null) : undefined;
}

/**
 * The value of every dimension in one running configuration: each dimension
 * read off the resolved `variables` / `secrets` of the module that declares it,
 * and a need's off the fields resolved for its need path (`null` when nothing
 * fulfils it).
 */
export function assignmentOf(
  dimensions: readonly Dimension[],
  values: {
    readonly variables: Readonly<Record<string, unknown>>;
    readonly secrets: Readonly<Record<string, unknown>>;
    readonly needs?: ReadonlyMap<string, Readonly<Record<string, unknown>> | null>;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const dimension of dimensions) {
    if (dimension.input === "resources") {
      const fields = values.needs?.get(dimension.name);
      if (dimension.projection === "presence") {
        out[dimension.key] = fields === null || fields === undefined ? ABSENT : PRESENT;
      } else {
        const field = fields?.[dimension.field!];
        out[dimension.key] =
          field === null || field === undefined
            ? null
            : (memberOfValue(dimension.declaration, field, dimension.member!) ?? null);
      }
      continue;
    }
    const value = values[dimension.input][dimension.name];
    if (dimension.projection === "presence") {
      out[dimension.key] = value === null || value === undefined ? ABSENT : PRESENT;
    } else if (dimension.projection === "whole") {
      out[dimension.key] = value === undefined ? null : typeof value === "bigint" ? Number(value) : value;
    } else {
      out[dimension.key] = value === null || value === undefined ? null : (memberOfValue(dimension.declaration, value, dimension.member!) ?? null);
    }
  }
  return out;
}

/** A dimension value as CEL reads it: a declared integer is an int64. */
export function asDeclared(value: unknown, declaration: Record<string, unknown>): unknown {
  if (declaration.type === "integer" && typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  return value;
}

/**
 * The dimensions and configurations a partial assignment (`AnalysisOptions.within`,
 * in the `data.configurations` entry encoding) keeps: each dimension it names
 * narrowed to that one value, and every configuration agreeing with it. A key
 * naming no dimension, or a value outside its dimension's domain, throws.
 */
export function restrictConfigurations(
  dimensions: readonly Dimension[],
  configurations: readonly Assignment[],
  within: Assignment,
): { dimensions: Dimension[]; configurations: Assignment[]; keys: Set<string> } {
  const chosen = new Map<string, unknown>();
  for (const [key, value] of Object.entries(within)) {
    const dimension = dimensions.find((d) => d.key === key);
    if (!dimension) {
      throw new Error(
        `'within' names '${key}', which is no dimension of this analysis` +
          (dimensions.length > 0 ? ` (its dimensions: ${dimensions.map((d) => `'${d.key}'`).join(", ")}).` : ` (it has none).`),
      );
    }
    const text = JSON.stringify(value);
    const domainValue = dimension.values.find((v) => v === value || JSON.stringify(v) === text);
    if (domainValue === undefined && !dimension.values.includes(value)) {
      throw new Error(
        `'within' gives '${key}' the value ${text}, which is outside its domain ` +
          `(${dimension.values.map((v) => JSON.stringify(v)).join(", ")}).`,
      );
    }
    chosen.set(key, domainValue);
  }
  const narrowed = dimensions.map((d) => (chosen.has(d.key) ? { ...d, values: [chosen.get(d.key)] } : d));
  const kept = configurations.filter((a) => [...chosen].every(([key, value]) => a[key] === value));
  return { dimensions: narrowed, configurations: kept, keys: new Set(kept.map(assignmentKey)) };
}
