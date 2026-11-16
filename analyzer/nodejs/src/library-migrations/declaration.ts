/**
 * The one reader of a `Telo.Library`'s `migrations:` block: the map from a
 * migration's diagnostic code to `{ severity?, reason, rules }`, each rule a
 * `rewrite` item. The block's shape is the built-in `Telo.Library` schema's to
 * refuse (`SCHEMA_VIOLATION`); this reader reads what is well formed and leaves
 * out a migration or a rule that is not, so no later check judges a spelling the
 * schema already refused.
 *
 * Browser-safe: no Node built-ins.
 */
import {
  isMigrationMap,
  isOpaqueMigrationValue,
  type MigrationMatch,
  type MigrationMatchType,
} from "./match.js";

/** The severity a migration reports with. */
export type MigrationSeverity = "warning" | "info" | "hint";

/** A `move:` / `copy:` source: a pointer into the matched node, or, with
 *  `binding`, into a `resolve` binding (`<binding>#<pointer>`). */
export interface MigrationSource {
  readonly binding?: string;
  readonly pointer: string;
  /** The key as written. */
  readonly written: string;
}

/** One positional write of a rule: the node at `from` lands at `to`. */
export interface MigrationPlacement {
  readonly from: MigrationSource;
  readonly to: string;
}

/** A `resolve:` entry: the declaration at `at` bound under `binding`, read as
 *  migrated or, with `before`, as it was before this migration's hand-over rule
 *  of that type. */
export interface MigrationBinding {
  readonly binding: string;
  readonly at: string;
  /** The type name `before: Self.<Name>` names, without `Self.`. */
  readonly before?: string;
}

/** A `rewrite` rule. */
export interface MigrationRule {
  /** The rule's position in its migration's `rules:`. */
  readonly index: number;
  /** The rule's dotted path in the module document (`migrations.CODE.rules[0]`). */
  readonly path: string;
  /** The type name `rewrite: Self.<Name>` names, without `Self.`. */
  readonly rewrite: string;
  readonly match: MigrationMatch;
  readonly remove: readonly string[];
  readonly move: readonly MigrationPlacement[];
  readonly copy: readonly MigrationPlacement[];
  /** A partial node merged over the matched node; literals only. */
  readonly set?: Readonly<Record<string, unknown>>;
  readonly resolve: readonly MigrationBinding[];
}

/** One migration of a library, named by its diagnostic code. */
export interface LibraryMigration {
  readonly code: string;
  readonly severity: MigrationSeverity;
  readonly reason: string;
  /** The migration's dotted path in the module document (`migrations.CODE`). */
  readonly path: string;
  readonly rules: readonly MigrationRule[];
  /** Every type a rule of the migration names at `rewrite: Self.<Name>`, the
   *  rules this reader leaves out as malformed included. */
  readonly rewrittenTypes: ReadonlySet<string>;
}

/** A migration's key: its diagnostic code, `<SUBJECT>_<PROBLEM>`. */
export const MIGRATION_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

const SELF_TYPE = /^Self\.([A-Z][A-Za-z0-9_]*)$/;
const POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;
const BINDING_SOURCE = /^([A-Za-z_][A-Za-z0-9_]*)#((?:\/(?:[^~/]|~[01])*)*)$/;
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEVERITIES: ReadonlySet<unknown> = new Set(["warning", "info", "hint"]);
const MATCH_TYPES: ReadonlySet<unknown> = new Set<MigrationMatchType>([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);
const MATCH_KEYS: ReadonlySet<string> = new Set(["type", "required", "const", "enum", "properties", "items"]);

/** The type name of a `Self.<Name>` spelling, or undefined. */
export function selfTypeName(written: unknown): string | undefined {
  return typeof written === "string" ? SELF_TYPE.exec(written)?.[1] : undefined;
}

/** A `move:` / `copy:` source key, or undefined when it is neither form. */
export function parseMigrationSource(written: string): MigrationSource | undefined {
  if (POINTER.test(written)) return { pointer: written, written };
  const bound = BINDING_SOURCE.exec(written);
  return bound ? { binding: bound[1], pointer: bound[2]!, written } : undefined;
}

/** The segments of a JSON Pointer, unescaped. */
export function migrationPointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function holdsOpaque(value: unknown): boolean {
  if (isOpaqueMigrationValue(value)) return true;
  if (Array.isArray(value)) return value.some(holdsOpaque);
  if (value !== null && typeof value === "object") return Object.values(value).some(holdsOpaque);
  return false;
}

/** `value` as a well-formed match, or undefined. */
export function readMigrationMatch(value: unknown): MigrationMatch | undefined {
  if (!isMigrationMap(value)) return undefined;
  if (Object.keys(value).some((key) => !MATCH_KEYS.has(key))) return undefined;
  const { type, required, enum: values, properties, items } = value;
  if (type !== undefined) {
    const list = Array.isArray(type) ? type : [type];
    if (list.length === 0 || !list.every((t) => MATCH_TYPES.has(t))) return undefined;
  }
  if (required !== undefined && !(Array.isArray(required) && required.every((key) => typeof key === "string"))) {
    return undefined;
  }
  if (values !== undefined && !(Array.isArray(values) && values.length > 0)) return undefined;
  if (holdsOpaque(value.const) || holdsOpaque(values)) return undefined;
  if (properties !== undefined) {
    if (!isMigrationMap(properties)) return undefined;
    for (const member of Object.values(properties)) {
      if (member !== false && readMigrationMatch(member) === undefined) return undefined;
    }
  }
  if (items !== undefined && readMigrationMatch(items) === undefined) return undefined;
  return value as MigrationMatch;
}

function readPlacements(value: unknown): MigrationPlacement[] | undefined {
  if (value === undefined) return [];
  if (!isMigrationMap(value)) return undefined;
  const placements: MigrationPlacement[] = [];
  for (const [key, to] of Object.entries(value)) {
    const from = parseMigrationSource(key);
    if (!from || typeof to !== "string" || !POINTER.test(to)) return undefined;
    placements.push({ from, to });
  }
  return placements;
}

function readBindings(value: unknown): MigrationBinding[] | undefined {
  if (value === undefined) return [];
  if (!isMigrationMap(value)) return undefined;
  const bindings: MigrationBinding[] = [];
  for (const [binding, entry] of Object.entries(value)) {
    if (!BINDING_NAME.test(binding) || !isMigrationMap(entry)) return undefined;
    const { at, before } = entry;
    if (typeof at !== "string" || !POINTER.test(at)) return undefined;
    if (Object.keys(entry).some((key) => key !== "at" && key !== "before")) return undefined;
    const beforeName = before === undefined ? undefined : selfTypeName(before);
    if (before !== undefined && beforeName === undefined) return undefined;
    bindings.push({ binding, at, ...(beforeName ? { before: beforeName } : {}) });
  }
  return bindings;
}

const RULE_KEYS: ReadonlySet<string> = new Set(["rewrite", "match", "remove", "move", "copy", "set", "resolve"]);

function readRule(value: unknown, index: number, path: string): MigrationRule | undefined {
  if (!isMigrationMap(value)) return undefined;
  if (Object.keys(value).some((key) => !RULE_KEYS.has(key))) return undefined;
  const rewrite = selfTypeName(value.rewrite);
  const match = readMigrationMatch(value.match);
  if (!rewrite || !match) return undefined;
  const remove = value.remove ?? [];
  if (!Array.isArray(remove) || !remove.every((pointer) => typeof pointer === "string" && POINTER.test(pointer))) {
    return undefined;
  }
  const move = readPlacements(value.move);
  const copy = readPlacements(value.copy);
  const resolve = readBindings(value.resolve);
  if (!move || !copy || !resolve) return undefined;
  const set = value.set;
  if (set !== undefined && (!isMigrationMap(set) || holdsOpaque(set))) return undefined;
  return {
    index,
    path,
    rewrite,
    match,
    remove: remove as string[],
    move,
    copy,
    ...(set !== undefined ? { set } : {}),
    resolve,
  };
}

/** The well-formed migrations a module document declares, in key order. */
export function readLibraryMigrations(moduleDoc: unknown): LibraryMigration[] {
  if (!isMigrationMap(moduleDoc) || moduleDoc.kind !== "Telo.Library") return [];
  const block = moduleDoc.migrations;
  if (!isMigrationMap(block)) return [];
  const migrations: LibraryMigration[] = [];
  for (const [code, entry] of Object.entries(block)) {
    if (!MIGRATION_CODE_PATTERN.test(code) || !isMigrationMap(entry)) continue;
    const { severity = "warning", reason, rules } = entry;
    if (!SEVERITIES.has(severity) || typeof reason !== "string" || reason === "" || !Array.isArray(rules)) continue;
    const path = `migrations.${code}`;
    const read: MigrationRule[] = [];
    const rewrittenTypes = new Set<string>();
    rules.forEach((rule, index) => {
      const rewrite = isMigrationMap(rule) ? selfTypeName(rule.rewrite) : undefined;
      if (rewrite) rewrittenTypes.add(rewrite);
      const parsed = readRule(rule, index, `${path}.rules[${index}]`);
      if (parsed) read.push(parsed);
    });
    migrations.push({ code, severity: severity as MigrationSeverity, reason, path, rules: read, rewrittenTypes });
  }
  return migrations;
}

/** The kind a rule writes at the root of the node it rewrites
 *  (`set: { kind: … }`), as written, or undefined. */
export function rootKindWritten(rule: MigrationRule): string | undefined {
  const kind = rule.set?.kind;
  return typeof kind === "string" ? kind : undefined;
}

const HAND_OVER_RULES = new WeakMap<LibraryMigration, ReadonlyMap<string, MigrationRule>>();

/**
 * A migration's hand-over rules, by type: the first rule of each type that
 * another rule of the same migration reads with `before`. Every later rule of
 * that type in the migration is its fallback.
 */
export function handOverRules(migration: LibraryMigration): ReadonlyMap<string, MigrationRule> {
  const known = HAND_OVER_RULES.get(migration);
  if (known) return known;
  const out = new Map<string, MigrationRule>();
  HAND_OVER_RULES.set(migration, out);
  for (const rule of migration.rules) {
    for (const binding of rule.resolve) {
      if (binding.before === undefined || out.has(binding.before)) continue;
      const first = migration.rules.find((r) => r.rewrite === binding.before && r !== rule);
      if (first) out.set(binding.before, first);
    }
  }
  return out;
}

/**
 * The types the library's rules rewrite that it no longer declares and that are
 * read as removed KINDS: those some rule rewriting them — in any migration, a
 * hand-over rule included — writes `kind:` at its root. A removed shape is never
 * a rewrite target, so any other undeclared target names nothing.
 */
export function removedKindNames(
  migrations: readonly LibraryMigration[],
  declared: (name: string) => boolean,
): Set<string> {
  const out = new Set<string>();
  for (const migration of migrations) {
    for (const rule of migration.rules) {
      if (!declared(rule.rewrite) && rootKindWritten(rule) !== undefined) out.add(rule.rewrite);
    }
  }
  return out;
}
