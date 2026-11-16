import { canonicalTypeSchemaId, isCompiledValue, type ResourceManifest } from "@telorun/sdk";
import { expansionTagLabel, isTaggedSentinel, plainChainOf } from "@telorun/templating";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isKindDocument } from "./kind-declaration.js";
import {
  migrationPointerSegments,
  readLibraryMigrations,
  removedKindNames,
  selfTypeName,
  type LibraryMigration,
  type MigrationRule,
} from "./library-migrations/declaration.js";
import { matchOverlap, schemaNodesAt, type MatchOverlap, type OverlapNote } from "./library-migrations/disjointness.js";
import { isMigrationMap, isOpaqueMigrationValue, type MigrationMatch } from "./library-migrations/match.js";
import { nearestName } from "./nearest-name.js";
import { isRefSlot } from "./ref-slot.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** The keys a kind's validation injects beside its author schema. */
const INJECTED_KIND_KEYS: ReadonlySet<string> = new Set(["kind", "metadata"]);

/** A rule's `set:` member path: `migrations.<CODE>.rules[<i>].set…`. */
const SET_PATH = /^migrations\.[^.]+\.rules\[\d+\]\.set(?=$|[.[])/;

/** The current schema of a type the library declares, or undefined for one it
 *  no longer declares. */
interface TypeReading {
  readonly schema: Record<string, any>;
  readonly injected: ReadonlySet<string>;
}

/**
 * A LIBRARY'S MIGRATIONS ARE CHECKED WHERE THEY ARE WRITTEN — at the library's
 * own `telo check`, and through the dependency verdict at a consumer's. The
 * kernel never runs these: they are publisher defects a consumer cannot fix.
 *
 *  - A tag anywhere in `migrations:` is `SCHEMA_VIOLATION`: a migration is
 *    data, and nothing in it is evaluated.
 *  - `MIGRATION_MATCH_OVERLAPS_SCHEMA`: neither the rule's `match` nor the match
 *    of the hand-over rule a `resolve` entry reads with `before` is proved
 *    disjoint from the current schema of the type it rewrites.
 *  - `MIGRATION_KIND_FOREIGN`: a `kind:` in `set:` names a kind the library
 *    neither declares, nor re-exports, nor rewrites as a removed kind.
 *  - `MIGRATION_TYPE_UNKNOWN`: a `rewrite:` names a type the library does not
 *    declare and no rule of it gives a `kind:` — a removed shape is never a
 *    rewrite target, so such a type is read as a removed kind only through a
 *    rule writing its replacement.
 *  - `MIGRATION_BINDING_INVALID`: a `resolve` entry naming neither a reference
 *    slot nor a required key, a `before` of a type the migration does not
 *    rewrite, a `copy:` from no binding, a `move:` from a binding.
 *
 * `set:` is not judged against the current schema: a migration is written
 * against the vocabulary of its own release. Browser-safe.
 */
export function validateLibraryMigrations(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const lib of manifests) {
    if (lib.kind !== "Telo.Library") continue;
    const moduleName = lib.metadata?.name as string | undefined;
    if (!moduleName || !rootModules.has(moduleName)) continue;
    const block = (lib as { migrations?: unknown }).migrations;
    if (block === undefined) continue;
    const filePath = (lib.metadata as { source?: string } | undefined)?.source;
    const resource = { kind: lib.kind, name: moduleName };
    const report = (code: string, path: string, message: string) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: SOURCE,
        message: `Telo.Library/${moduleName}: ${message}`,
        data: { resource, filePath, path },
      });

    for (const site of opaqueSites(block, "migrations")) report("SCHEMA_VIOLATION", site.path, site.message);

    const declaredKinds = new Set<string>();
    for (const m of manifests) {
      const module = (m.metadata as { module?: string } | undefined)?.module;
      if ((module === undefined || module === moduleName) && isKindDocument(m) && typeof m.metadata?.name === "string") {
        declaredKinds.add(m.metadata.name);
      }
    }
    const exportedKinds = (lib as { exports?: { kinds?: unknown } }).exports?.kinds;
    const reExported = new Set(
      Array.isArray(exportedKinds) ? exportedKinds.filter((k): k is string => typeof k === "string" && k.includes(".")) : [],
    );
    const imports = (lib as { imports?: unknown }).imports;
    const importAliases = new Set(isMigrationMap(imports) ? Object.keys(imports) : []);
    const migrations = readLibraryMigrations(lib);

    const readings = new Map<string, TypeReading | undefined>();
    const typeReading = (name: string): TypeReading | undefined => {
      if (readings.has(name)) return readings.get(name);
      const definition = registry.resolve(`${moduleName}.${name}`);
      const reading: TypeReading | undefined = definition
        ? { schema: (registry.effectiveSchemaOf(definition) ?? {}) as Record<string, any>, injected: INJECTED_KIND_KEYS }
        : (() => {
            const shape = registry.schemaForId(canonicalTypeSchemaId(moduleName, name));
            return shape ? { schema: shape, injected: new Set<string>() } : undefined;
          })();
      readings.set(name, reading);
      return reading;
    };
    const removedKinds = removedKindNames(migrations, (name) => typeReading(name) !== undefined);
    for (const migration of migrations) {
      for (const rule of migration.rules) {
        if (typeReading(rule.rewrite) || removedKinds.has(rule.rewrite)) continue;
        report(
          "MIGRATION_TYPE_UNKNOWN",
          `${rule.path}.rewrite`,
          `\`rewrite: Self.${rule.rewrite}\` names no type ${moduleName} declares. Name the current type that now ` +
            `holds the position, or, for a removed kind, give it a replacement with a rule writing ` +
            `\`set: { kind: Self.<Kind> }\` at its root.`,
        );
      }
    }
    const overlapOf = (rule: MigrationRule, type: string): MatchOverlap | undefined => {
      const reading = typeReading(type);
      if (!reading) return undefined;
      return matchOverlap(reading.schema, rule.match, {
        lookup: registry.shapeLookup,
        injectedRootKeys: reading.injected,
      });
    };

    // Read off every rule as written, so a rule refused for another reason
    // still has its kinds judged.
    for (const written of kindsWritten(block)) {
      const self = selfTypeName(written.kind);
      if (self !== undefined && (declaredKinds.has(self) || removedKinds.has(self))) continue;
      if (reExported.has(written.kind)) continue;
      report("MIGRATION_KIND_FOREIGN", written.path, foreignKindMessage(written.kind, {
        moduleName,
        kinds: [...declaredKinds, ...removedKinds],
        importAliases,
      }));
    }

    for (const migration of migrations) {
      for (const rule of migration.rules) {
        const invalidBefore = checkBindings(migration, rule, typeReading, registry, report);
        if (invalidBefore) continue;
        const overlap = overlapOf(rule, rule.rewrite);
        if (!overlap) continue;
        const befores = rule.resolve.flatMap((binding) => (binding.before ? [binding.before] : []));
        const handedOver = befores.some((type) => {
          const handOver = migration.rules.find((r) => r.rewrite === type);
          return handOver !== undefined && overlapOf(handOver, type) === undefined;
        });
        if (handedOver) continue;
        report("MIGRATION_MATCH_OVERLAPS_SCHEMA", `${rule.path}.match`, overlapMessage(rule, overlap, befores));
      }
    }
  }
  return out;
}

/** Reports the rule's binding defects; true when a `before` names a type the
 *  migration does not rewrite, so its recognition cannot be judged. */
function checkBindings(
  migration: LibraryMigration,
  rule: MigrationRule,
  typeReading: (name: string) => TypeReading | undefined,
  registry: DefinitionRegistry,
  report: (code: string, path: string, message: string) => void,
): boolean {
  let invalidBefore = false;
  const target = typeReading(rule.rewrite);
  for (const binding of rule.resolve) {
    const at = `${rule.path}.resolve.${binding.binding}`;
    if (binding.before !== undefined && !migration.rewrittenTypes.has(binding.before)) {
      invalidBefore = true;
      report(
        "MIGRATION_BINDING_INVALID",
        `${at}.before`,
        `\`before: Self.${binding.before}\` names a type this migration does not rewrite; add a ` +
          `\`rewrite: Self.${binding.before}\` rule to ${migration.code}, or read the declaration as ` +
          `migrated by leaving out \`before\`.`,
      );
    }
    const segments = migrationPointerSegments(binding.at);
    if (requiresAlong(rule.match, segments)) continue;
    if (target && schemaNodesAt(target.schema, target.schema, segments, registry.shapeLookup).some((node) => isRefSlot(node))) {
      continue;
    }
    report(
      "MIGRATION_BINDING_INVALID",
      `${at}.at`,
      `\`at: ${binding.at}\` names ` +
        (target ? `neither a reference slot of Self.${rule.rewrite} nor a key \`match\` requires` : `no key \`match\` requires`) +
        `; point it at the \`!ref\` or inline declaration the node holds, and require that key in \`match\`.`,
    );
  }
  const bindings = new Set(rule.resolve.map((binding) => binding.binding));
  for (const { from } of rule.copy) {
    if (from.binding === undefined || bindings.has(from.binding)) continue;
    report(
      "MIGRATION_BINDING_INVALID",
      `${rule.path}.copy.${from.written}`,
      `\`copy:\` source \`${from.written}\` reads the binding \`${from.binding}\`, which no \`resolve:\` entry ` +
        `of this rule declares; declare it under \`resolve:\`, or copy from the matched node with a pointer.`,
    );
  }
  for (const { from } of rule.move) {
    if (from.binding === undefined) continue;
    report(
      "MIGRATION_BINDING_INVALID",
      `${rule.path}.move.${from.written}`,
      `\`move:\` source \`${from.written}\` reads a binding, and a rule writes only its own node; carry the ` +
        `value with \`copy:\` instead.`,
    );
  }
  return invalidBefore;
}

/** True when every segment of a pointer is a key `match` requires, each inside
 *  the `properties` match of the one before. */
function requiresAlong(match: MigrationMatch, segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  let current: MigrationMatch | undefined = match;
  for (const segment of segments) {
    if (!current?.required?.includes(segment)) return false;
    const member: MigrationMatch | false | undefined = current.properties?.[segment];
    current = member === false ? undefined : member;
  }
  return true;
}

/** Every `kind:` string a rule's `set:` writes, at any depth, in every rule
 *  of the `migrations:` block as written. */
function kindsWritten(block: unknown): { kind: string; path: string }[] {
  const found: { kind: string; path: string }[] = [];
  if (!isMigrationMap(block)) return found;
  for (const [code, migration] of Object.entries(block)) {
    const rules = isMigrationMap(migration) ? migration.rules : undefined;
    if (!Array.isArray(rules)) continue;
    rules.forEach((rule, i) => {
      if (isMigrationMap(rule)) found.push(...kindsInSet(rule.set, `migrations.${code}.rules[${i}].set`));
    });
  }
  return found;
}

/** Every `kind:` string a `set:` writes, at any depth. */
function kindsInSet(set: unknown, path: string): { kind: string; path: string }[] {
  const found: { kind: string; path: string }[] = [];
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`));
    } else if (isMigrationMap(value)) {
      for (const [key, member] of Object.entries(value)) {
        if (key === "kind" && typeof member === "string") found.push({ kind: member, path: `${at}.kind` });
        else walk(member, `${at}.${key}`);
      }
    }
  };
  walk(set, path);
  return found;
}

function foreignKindMessage(
  kind: string,
  library: { moduleName: string; kinds: readonly string[]; importAliases: ReadonlySet<string> },
): string {
  const base =
    `\`${kind}\` is neither a kind of ${library.moduleName} nor one it re-exports; a migration writes only ` +
    `its own library's kinds.`;
  const dot = kind.indexOf(".");
  const prefix = dot < 0 ? undefined : kind.slice(0, dot);
  const name = dot < 0 ? kind : kind.slice(dot + 1);
  if (prefix === library.moduleName && library.kinds.includes(name)) return `${base} Write it \`Self.${name}\`.`;
  if (prefix === "Self") {
    const near = nearestName(name, library.kinds);
    return near ? `${base} Did you mean \`Self.${near}\`?` : base;
  }
  if (prefix !== undefined && library.importAliases.has(prefix)) {
    return `${base} List \`${kind}\` under \`exports.kinds\` to write it.`;
  }
  return base;
}

function list(keys: readonly string[]): string {
  const quoted = keys.map((key) => `\`${key}\``);
  return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

function noteText(note: OverlapNote): string {
  switch (note.kind) {
    case "open":
      return note.pointer === ""
        ? `it declares no \`additionalProperties: false\`, so it accepts \`${note.key}\``
        : `the schema at \`${note.pointer}\` declares no \`additionalProperties: false\`, so it accepts \`${note.key}\``;
    case "declared":
      return note.pointer === ""
        ? `it declares \`${note.key}\``
        : `the schema at \`${note.pointer}\` declares \`${note.key}\``;
    case "unjudged":
      return `\`${note.keyword}\` at \`${note.pointer}\` is read as accepting every value`;
    case "reference-slot":
      return `\`${note.pointer}\` is a reference slot, which accepts any \`!ref\` or declaration`;
  }
}

function overlapMessage(rule: MigrationRule, overlap: MatchOverlap, befores: readonly string[]): string {
  const type = `Self.${rule.rewrite}`;
  const { branch } = overlap;
  const union = branch.union !== undefined;
  const label = !union
    ? `the current schema of ${type}`
    : branch.tag
      ? `the current \`${branch.tag.value}\` branch of ${type}`
      : branch.title
        ? `the current branch "${branch.title}" of ${type}`
        : `the current \`${branch.union!.keyword}[${branch.union!.index}]\` branch of ${type}`;
  const mentioned = new Set([...(rule.match.required ?? []), ...Object.keys(rule.match.properties ?? {})]);
  const unmentioned = branch.required.filter((key) => key !== branch.tag?.key && !mentioned.has(key));
  const subject = branch.tag ? `a \`${branch.tag.value}\` value` : "a value";
  const witness = `${subject}${unmentioned.length > 0 ? ` with ${list(unmentioned)}` : ""} matches it`;
  const notes = overlap.notes
    .filter((note) => !(note.kind === "declared" && note.pointer === "" && note.key === branch.tag?.key))
    .map(noteText);
  const reading = notes.length > 0 ? `, since ${notes.join("; ")}` : "";
  const readKeys = [...rule.remove, ...rule.move.filter((m) => m.from.binding === undefined).map((m) => m.from.pointer)]
    .map((pointer) => migrationPointerSegments(pointer)[0])
    .filter((key): key is string => key !== undefined);
  const refused = branch.closedKeys
    ? [...new Set(readKeys)].find((key) => !branch.closedKeys!.has(key) && !INJECTED_KIND_KEYS.has(key) && !(rule.match.required ?? []).includes(key))
    : undefined;
  const which = union ? "that branch" : "the schema";
  const fix = refused
    ? `Require a key ${which} refuses, such as \`${refused}\`.`
    : `Require a key ${which} refuses, or pin a \`const\` / \`enum\` it refuses.`;
  const handOver =
    befores.length > 0
      ? ` Nor is the match of the hand-over rule its \`before: ${befores.map((b) => `Self.${b}`).join("` / `before: ")}\` reads.`
      : "";
  return `\`match\` also accepts ${label}: ${witness}${reading}.${handOver} ${fix}`;
}

/** Every tagged or compiled value in `migrations:`, with what it is refused with. */
function opaqueSites(value: unknown, path: string): { path: string; message: string }[] {
  const sites: { path: string; message: string }[] = [];
  const walk = (node: unknown, at: string): void => {
    if (isOpaqueMigrationValue(node)) {
      const tag = isTaggedSentinel(node)
        ? `!${node.engine}`
        : (expansionTagLabel(node) ?? (isCompiledValue(node) ? "an expression" : "a tag"));
      sites.push({ path: at, message: opaqueMessage(node, at, tag) });
      return;
    }
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${at}[${i}]`));
    else if (node !== null && typeof node === "object") {
      for (const [key, member] of Object.entries(node)) walk(member, `${at}.${key}`);
    }
  };
  walk(value, path);
  return sites;
}

function opaqueMessage(node: unknown, path: string, tag: string): string {
  const inSet = SET_PATH.exec(path);
  const written = tag.startsWith("!") ? `\`${tag}\`` : tag;
  if (!inSet) {
    return `A migration is data, and no expression runs in one: \`${path}\` holds ${written}. Write the value as a literal.`;
  }
  const destination = "/" + path.slice(inSet[0].length).replace(/^\./, "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).join("/");
  const chain = plainChainOf(node);
  const source = chain?.startsWith("self.") ? `/${chain.slice("self.".length).split(".").join("/")}` : undefined;
  const carry = source && destination !== "/"
    ? `Carry the value with \`copy: { ${source}: ${destination} }\`.`
    : "Carry a value of the matched node with `copy:`, or one of a `resolve` binding with `copy: { <binding>#<pointer>: … }`.";
  return `\`set:\` holds literals only, and no expression runs in a migration; \`${path}\` holds ${written}. ${carry}`;
}
