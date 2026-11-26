import type { ResourceManifest } from "@telorun/sdk";
import { expansionTagLabel, expansionTagOf, type ExpansionSentinel } from "@telorun/templating";
import { KERNEL_BUILTINS } from "./builtins.js";
import { kindDeclarationOf } from "./kind-declaration.js";
import { kindDocumentIn, type LoadedKindScope } from "./loaded-kind-scope.js";
import type { LoadedModule, ScopedImportOption, ScopeHolderStep } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import { isScopeMember } from "./scope-declarations.js";
import { importFieldRefusals, isImportDocument, type ImportFieldRefusal } from "./loader-expansion-refusals.js";

/**
 * The `Telo.Import` documents a module declares as SCOPE MEMBERS — in an
 * `x-telo-scope` array of a top-level declaration, or of a member of one, at any
 * depth — read over a loaded graph before any registry exists, each holder's
 * kind resolved through its module's own import edges (a built-in `Telo.<Kind>`
 * from the built-in vocabulary). Which fields are scopes is the kind's schema's
 * to say, never an array's shape.
 *
 * Such an import is a module instance of its own: its path is the importer's,
 * one segment per holder from the module's top level down, then the member's
 * name ({@link scopedInstancePath}).
 *
 * Browser-safe.
 */

export interface ScopedImportSite {
  /** The member, as the declaring file holds it: for one a choice declares at
   *  a scope-member position, the branch, named by the tag's `metadata`. */
  readonly member: ResourceManifest;
  /** Its name — absent only for a refused member whose `metadata` is not
   *  written plainly. */
  readonly alias: string | undefined;
  /** What the loader refuses at the member's own fields; a refused member is
   *  read no further. */
  readonly refusals: readonly ImportFieldRefusal[];
  /** The holders from the top level down; the last holds the member. */
  readonly holders: readonly ScopeHolderStep[];
  /** The top-level holder's kind, as written — the tag (`!if`) for a holder a
   *  whole-document choice declares. */
  readonly holderKind: string;
  /** The top-level document holding it, by its index in the file. */
  readonly document: number;
  /** Where it is written in that document, option keys included. */
  readonly place: readonly (string | number)[];
  /** Every option on the way to it, outermost first. */
  readonly options: readonly ScopedImportOption[];
}

/** The member's place inside its top-level holder (`with[0]`, `with.then[0]`,
 *  `then.with[0]`). */
export function scopedMemberPath(place: readonly (string | number)[]): string {
  let out = "";
  for (const key of place) out += typeof key === "number" ? `[${key}]` : out.length === 0 ? key : `.${key}`;
  return out;
}

/** The instance path of a scoped import reached from an instance at `importer`. */
export function scopedInstancePath(
  importer: readonly string[],
  holders: readonly ScopeHolderStep[],
  alias: string,
): string[] {
  return [...importer, ...holders.map((h) => h.name), alias];
}

/** The named top-level scope fields of a schema: a property of the root, or of
 *  a root variant, carrying `x-telo-scope` directly or through a local `$ref`.
 *  Read here rather than through the reference reach, which is memoized per
 *  schema node and must not see a kind's schema before its analysis
 *  canonicalizes it. */
function scopeFieldsOfSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const root = schema as Record<string, any>;
  const local = (node: unknown, depth = 0): Record<string, any> | undefined => {
    if (!node || typeof node !== "object" || depth > 16) return undefined;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return node as Record<string, any>;
    let target: unknown = root;
    for (const key of ref.slice(2).split("/")) {
      target = (target as Record<string, unknown> | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return local(target, depth + 1);
  };
  const out: string[] = [];
  const objects = [local(root), ...["anyOf", "oneOf", "allOf"].flatMap((k) => (Array.isArray(root[k]) ? root[k] : []).map((b: unknown) => local(b)))];
  for (const object of objects) {
    const properties = object?.properties;
    if (!properties || typeof properties !== "object") continue;
    for (const [field, node] of Object.entries(properties as Record<string, unknown>)) {
      const resolved = local(node);
      const scoped = (node as { "x-telo-scope"?: unknown } | undefined)?.["x-telo-scope"] ?? resolved?.["x-telo-scope"];
      if (scoped !== undefined && !out.includes(field)) out.push(field);
    }
  }
  return out;
}

/** The scope fields of `kind` written in `mod`, following a merge-form `extends`. */
function scopeFieldsOf(
  graph: LoadedKindScope,
  mod: LoadedModule,
  kind: string,
  seen: Set<object> = new Set(),
): string[] {
  let definition: { schema?: unknown; extends?: unknown; base?: unknown } | undefined;
  let module = mod;
  if (kind.startsWith("Telo.")) {
    const name = kind.slice("Telo.".length);
    definition = KERNEL_BUILTINS.find((d) => d.kind === "Telo.Definition" && d.metadata.name === name);
  } else {
    const found = kindDocumentIn(graph, mod, kind);
    if (!found) return [];
    definition = kindDeclarationOf(found.doc) as typeof definition;
    module = found.module;
  }
  if (!definition || seen.has(definition)) return [];
  seen.add(definition);
  const own = scopeFieldsOfSchema(definition.schema);
  if (typeof definition.extends !== "string" || definition.base !== undefined) return own;
  const inherited = scopeFieldsOf(graph, module, definition.extends, seen);
  return [...own, ...inherited.filter((f) => !own.includes(f))];
}

/** The branches a choice writes, each with its id and its keys in the tag. */
function branchesOf(sentinel: ExpansionSentinel): { branch: string; keys: (string | number)[]; value: unknown }[] {
  const body = sentinel as Record<string, unknown>;
  if (expansionTagOf(sentinel) === "if") {
    return ["then", "else"].filter((b) => Object.hasOwn(body, b)).map((b) => ({ branch: b, keys: [b], value: body[b] }));
  }
  const out: { branch: string; keys: (string | number)[]; value: unknown }[] = [];
  const cases = body.cases;
  if (cases && typeof cases === "object" && !Array.isArray(cases)) {
    for (const [key, value] of Object.entries(cases)) out.push({ branch: `case:${key}`, keys: ["cases", key], value });
  }
  if (Object.hasOwn(body, "default")) out.push({ branch: "default", keys: ["default"], value: body.default });
  return out;
}

const isChoice = (value: unknown): value is ExpansionSentinel => {
  const tag = expansionTagOf(value);
  return tag === "if" || tag === "switch";
};

const nameOf = (value: unknown): string | undefined => {
  const name = (value as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
  return typeof name === "string" ? name : undefined;
};

/** Every scoped `Telo.Import` among `manifests`, the top-level documents of one
 *  file of `mod`, in document order — wherever a choice writes it: beneath a
 *  chosen holder, in a chosen scope array, as a member chosen at a scope-member
 *  position, in every option at any depth. */
export function scopedImportsOf(
  graph: LoadedKindScope,
  mod: LoadedModule,
  manifests: readonly unknown[],
): ScopedImportSite[] {
  const out: ScopedImportSite[] = [];
  const fields = new Map<string, string[]>();
  const fieldsOf = (kind: string): string[] => {
    let known = fields.get(kind);
    if (!known) fields.set(kind, (known = scopeFieldsOf(graph, mod, kind)));
    return known;
  };
  type Keys = readonly (string | number)[];
  type Walk = { document: number; holderKind: string };
  const option = (at: Keys, branch: string): ScopedImportOption => ({ at, branch });
  /** The members of the scope `value` holds, written at `place`. */
  const scope = (value: unknown, walk: Walk, holders: ScopeHolderStep[], holder: string, field: string, place: Keys, options: readonly ScopedImportOption[]): void => {
    if (isChoice(value)) {
      for (const b of branchesOf(value)) scope(b.value, walk, holders, holder, field, [...place, ...b.keys], [...options, option(place, b.branch)]);
      return;
    }
    if (!Array.isArray(value)) return;
    value.forEach((entry, index) => {
      member(entry, walk, [...holders, { name: holder, field, index }], [...place, index], options, undefined);
    });
  };
  /** One scope member written at `place`; `named` is the name the outermost
   *  tag gives a member a choice declares. */
  const member = (entry: unknown, walk: Walk, holders: ScopeHolderStep[], place: Keys, options: readonly ScopedImportOption[], named: string | undefined): void => {
    if (isChoice(entry)) {
      const name = nameOf(entry) ?? named;
      if (name === undefined) return;
      for (const b of branchesOf(entry)) member(b.value, walk, holders, [...place, ...b.keys], [...options, option(place, b.branch)], name);
      return;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const record = entry as ResourceManifest;
    const name = named ?? nameOf(record);
    if (isImportDocument(record as unknown as Record<string, unknown>)) {
      const refusals = importFieldRefusals(record as unknown as Record<string, unknown>, name);
      if (refusals.length > 0) {
        out.push({ member: record, alias: name, refusals, holders, holderKind: walk.holderKind, document: walk.document, place, options });
        return;
      }
    }
    if (typeof record.kind !== "string" || name === undefined) return;
    if (named === undefined && !isScopeMember(record)) return;
    if (record.kind === "Telo.Import") {
      out.push({ member: record, alias: name, refusals: [], holders, holderKind: walk.holderKind, document: walk.document, place, options });
    } else if (!kindDeclarationOf(record) && !isModuleKind(record.kind)) {
      declaration(record, name, walk, holders, place, options);
    }
  };
  /** The scopes of the declaration `holder`, named `name`, written at `place`. */
  const declaration = (holder: ResourceManifest, name: string, walk: Walk, holders: ScopeHolderStep[], place: Keys, options: readonly ScopedImportOption[]): void => {
    for (const field of fieldsOf(holder.kind as string)) {
      scope((holder as unknown as Record<string, unknown>)[field], walk, holders, name, field, [...place, field], options);
    }
  };
  /** A whole document behind a tag: each branch declares the holder it names. */
  const chosenDocument = (value: unknown, walk: Walk, name: string, place: Keys, options: readonly ScopedImportOption[]): void => {
    if (isChoice(value)) {
      for (const b of branchesOf(value)) chosenDocument(b.value, walk, name, [...place, ...b.keys], [...options, option(place, b.branch)]);
      return;
    }
    const record = value as ResourceManifest | undefined;
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.kind !== "string") return;
    if (record.kind === "Telo.Import" || isModuleKind(record.kind) || kindDeclarationOf(record)) return;
    declaration(record, name, walk, [], place, options);
  };
  manifests.forEach((m, document) => {
    if (isChoice(m)) {
      const name = nameOf(m);
      if (name !== undefined) chosenDocument(m, { document, holderKind: expansionTagLabel(m)! }, name, [], []);
      return;
    }
    const doc = m as ResourceManifest | undefined;
    if (!doc || typeof doc.kind !== "string" || typeof doc.metadata?.name !== "string") return;
    if (doc.kind === "Telo.Import" || isModuleKind(doc.kind) || kindDeclarationOf(doc)) return;
    declaration(doc, doc.metadata.name, { document, holderKind: doc.kind }, [], [], []);
  });
  return out;
}
