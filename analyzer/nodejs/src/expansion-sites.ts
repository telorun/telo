/**
 * Where every expansion construct — `!if`, `!switch`, `!for-each` and the `...`
 * splice — is written, what position it holds, and whether that position and
 * its mapping's shape admit it. The ONE reader of tag positions and shapes: the
 * analysis pass reports its refusals, the kernel runs it over a library's own
 * documents when an import loads it, and the expansion itself (later) reads its
 * sites. Positions the loader reads before anything is expanded — a module
 * doc's `metadata`, `imports:` and `include:` — are the loader's
 * (`loader-expansion-refusals.ts`) and skipped here.
 *
 * A position is decided by structure and, inside a declaration, by its kind's
 * schema: an item of a top-level `x-telo-scope` field is a declaration
 * position, an item of a list whose items are the shared step grammar a step
 * position; never by a field name.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { EMITTED_STEP_MEMBER } from "@telorun/sdk";
import {
  expansionBody,
  expansionShapeCode,
  expansionTagLabel,
  expansionTagOf,
  isExpansionSentinel,
  isRefSentinel,
  isTaggedSentinel,
  refRefusalMessage,
  SPLICE_KEY,
  type ExpansionSentinel,
  type ExpansionTag,
} from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { manifestFragment, manifestFragmentOf } from "./manifest-schemas.js";
import { definitionInScope } from "./module-alias-scope.js";
import { isModuleKind } from "./module-kinds.js";
import { refSentinelRefusal, refSentinelTarget } from "./ref-sentinel-target.js";
import { isResolvedReference } from "./resolved-reference.js";
import { createAjv } from "./schema-compat.js";
import { gatherPropertySchemas, resolveLocalRef } from "./schema-walk.js";
import { readStepSlot, STEP_FRAGMENT } from "./step-slot.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type Range } from "./types.js";

/** What a construct's place makes of it. */
export type ExpansionPosition =
  /** A whole resource document. */
  | "document"
  /** An item of a module doc's `targets:`. */
  | "module-target"
  /** An entry of a template body's `resources:`. */
  | "template-resource"
  /** An item of a top-level `x-telo-scope` field. */
  | "scope-member"
  /** An item of a list of steps. */
  | "step"
  /** An item of any other list. */
  | "list-item"
  /** The value of a field. */
  | "field"
  /** The value of a `...` key. */
  | "splice";

const DECLARATION_POSITIONS: ReadonlySet<ExpansionPosition> = new Set([
  "document",
  "template-resource",
  "scope-member",
]);

/** One expansion construct where it is written. */
export interface ExpansionSite {
  /** The top-level document holding it; for a whole-document tag, the tag. */
  readonly holder: ResourceManifest;
  /** Its path inside the holder (`""` for a whole document). */
  readonly path: string;
  readonly construct: ExpansionTag | "splice";
  readonly position: ExpansionPosition;
  /** Inside a `Telo.Definition`'s template body. */
  readonly inTemplate: boolean;
  /** Inside another tag's branch or `emit:`. */
  readonly nested: boolean;
  /** The tag's mapping as loaded, or a splice's value. */
  readonly value: unknown;
  /** Refused here, with this code. */
  readonly refusal?: string;
}

export interface ExpansionReading {
  readonly sites: readonly ExpansionSite[];
  /** Every refusal, each reported once at its construct. */
  readonly diagnostics: readonly AnalysisDiagnostic[];
  /** Every refused construct and refused `!ref`, by the document holding it and
   *  its path there — what {@link withoutRefusedExpansionConsequences} drops beneath. */
  readonly refused: readonly { readonly holder: ResourceManifest; readonly path: string }[];
}

const SOURCE = "telo-analyzer";
const SPLICE = SPLICE_KEY;


/**
 * Read every expansion construct and every `!ref` the `!ref` grammar refuses in
 * `manifests` — the entry's own documents; a dependency's forwarded declaration
 * is its own module's to judge. `documents` are the whole-document tags, held
 * apart from `manifests` because no other pass reads them as declarations.
 */
export function readExpansionSites(
  manifests: readonly ResourceManifest[],
  documents: readonly ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  /** Read every document, a dependency's included — what a consumer's check
   *  expands a library's template body by. */
  everyDocument = false,
): ExpansionReading {
  const sites: ExpansionSite[] = [];
  const refused: { holder: ResourceManifest; path: string }[] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  // The entry's own modules: what a module doc in the set names, or no module.
  const rootModules = new Set(
    manifests.filter((m) => isModuleKind(m.kind)).map((m) => m.metadata?.name as string),
  );
  const isOwn = (m: ResourceManifest): boolean => {
    if (everyDocument) return true;
    if (isForwardedDeclaration(m)) return false;
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    return typeof module !== "string" || rootModules.has(module);
  };
  const own = manifests.filter(isOwn);

  const definitionOf = (kind: string, from: unknown): ResourceDefinition | undefined =>
    definitionInScope<ResourceDefinition>(
      registry,
      kind,
      (from as { metadata?: { module?: unknown } } | undefined)?.metadata,
      aliases,
      aliasesByModule,
    );

  for (const holder of own) {
    const walker = new Walker(holder, sites, diagnostics, refused, (kind) => definitionOf(kind, holder));
    walker.holderDocument();
  }

  // A whole-document tag: a declaration position, except as the first document
  // of the file holding the module doc, which is never chosen.
  const moduleFiles = new Set(
    manifests.filter((m) => isModuleKind(m.kind)).map((m) => sourceOf(m)),
  );
  const firstLines = new Map<string, number>();
  for (const m of [...manifests, ...documents]) {
    const source = sourceOf(m);
    const line = (m.metadata as { sourceLine?: unknown } | undefined)?.sourceLine;
    if (source === undefined || typeof line !== "number") continue;
    firstLines.set(source, Math.min(firstLines.get(source) ?? Infinity, line));
  }
  for (const document of documents.filter(isOwn)) {
    const walker = new Walker(document, sites, diagnostics, refused, (kind) => definitionOf(kind, document));
    const source = sourceOf(document);
    const line = (document.metadata as { sourceLine?: unknown } | undefined)?.sourceLine;
    const first =
      source !== undefined && moduleFiles.has(source) && line === firstLines.get(source);
    walker.wholeDocument(first);
  }
  return { sites, diagnostics, refused };
}

/** A schema node with the root its local `$ref`s resolve against. */
interface Cursor {
  readonly schema?: Record<string, any>;
  readonly root?: Record<string, any>;
}

const NO_CURSOR: Cursor = {};

interface Place {
  /** May a `!if` / `!switch` stand here. */
  readonly branchAllowed: boolean;
  readonly inTemplate: boolean;
  readonly nested: boolean;
  /** The top-level `x-telo-scope` fields of the declaration whose root this
   *  value's path is measured from, with that root's depth in `keys`. */
  readonly declaration?: { readonly depth: number; readonly scopes: ReadonlySet<string> };
}

class Walker {
  constructor(
    private readonly holder: ResourceManifest,
    private readonly sites: ExpansionSite[],
    private readonly diagnostics: AnalysisDiagnostic[],
    private readonly refused: { holder: ResourceManifest; path: string }[],
    private readonly definitionOf: (kind: string) => ResourceDefinition | undefined,
  ) {}

  /** A top-level document that is not itself a tag. */
  holderDocument(): void {
    const doc = this.holder as Record<string, unknown>;
    if (this.holder.kind === "Telo.Definition") {
      for (const [key, value] of Object.entries(doc)) {
        this.scanRefs(value, [key], key === "resources" || TEMPLATE_BODY_FIELDS.has(key));
      }
    } else {
      this.scanRefs(doc, [], false);
    }
    if (isModuleKind(this.holder.kind)) {
      const outside: Place = { branchAllowed: false, inTemplate: false, nested: false };
      for (const [key, value] of Object.entries(doc)) {
        // The loader's positions, refused before any document is built.
        if (key === "metadata" || key === "imports" || key === "include") continue;
        if (key === "targets" && Array.isArray(value)) {
          value.forEach((item, i) =>
            this.visit(item, [key, i], NO_CURSOR, "module-target", {
              ...outside,
              branchAllowed: true,
            }),
          );
          continue;
        }
        this.visit(value, [key], NO_CURSOR, "field", outside);
      }
      return;
    }
    if (isKindDocumentOrImport(this.holder)) {
      const outside: Place = { branchAllowed: false, inTemplate: false, nested: false };
      const body: Place = { branchAllowed: true, inTemplate: true, nested: false };
      const isDefinition = this.holder.kind === "Telo.Definition";
      for (const [key, value] of Object.entries(doc)) {
        if (isDefinition && key === "resources" && Array.isArray(value)) {
          value.forEach((entry, i) =>
            this.visit(entry, [key, i], NO_CURSOR, "template-resource", body),
          );
          continue;
        }
        if (isDefinition && TEMPLATE_BODY_FIELDS.has(key)) {
          this.visit(value, [key], NO_CURSOR, "field", body);
          continue;
        }
        this.visit(value, [key], NO_CURSOR, "field", outside);
      }
      return;
    }
    const place: Place = {
      branchAllowed: true,
      inTemplate: false,
      nested: false,
      declaration: { depth: 0, scopes: this.scopeFieldsOf(this.cursorOf(this.holder.kind)) },
    };
    const cursor = this.cursorOf(this.holder.kind);
    for (const [key, value] of Object.entries(doc)) {
      if (key === "kind" || key === "metadata") continue;
      this.visitField(key, value, [], cursor, place);
    }
  }

  /** A whole document written behind a tag. */
  wholeDocument(first: boolean): void {
    this.scanRefs(this.holder, [], false);
    const place: Place = { branchAllowed: !first, inTemplate: false, nested: false };
    if (first) {
      const tag = expansionTagOf(this.holder)!;
      const code = tag === "for-each" ? "REPEAT_OUTSIDE_TEMPLATE" : "BRANCH_POSITION_INVALID";
      this.record(this.holder, [], "document", place, code,
        tag === "for-each"
          ? repeatOutsideMessage(`'!${tag}'`)
          : `'!${tag}' is the first document of a module file, where the module document belongs; ` +
              `the module document is never chosen. Put the module document first.`);
      return;
    }
    this.visit(this.holder, [], NO_CURSOR, "document", place);
  }

  private visit(
    value: unknown,
    keys: (string | number)[],
    cursor: Cursor,
    position: ExpansionPosition,
    place: Place,
  ): void {
    if (isExpansionSentinel(value)) {
      this.visitTag(value, keys, cursor, position, place);
      return;
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
    if ((value as { __compiled?: unknown }).__compiled) return;
    if (Array.isArray(value)) {
      const itemPosition: ExpansionPosition = isStepList(cursor)
        ? "step"
        : this.isScopeField(keys, place)
          ? "scope-member"
          : "list-item";
      value.forEach((item, i) => this.visit(item, [...keys, i], childCursor(cursor, i), itemPosition, place));
      return;
    }
    const record = value as Record<string, unknown>;
    if (position === "step" && EMITTED_STEP_MEMBER in record) {
      // Reported at the key; what is found about the step it makes unreadable
      // is its consequence.
      this.refused.push({ holder: this.holder, path: pathOf(keys) });
      this.diagnostics.push(
        this.diagnostic("REPEAT_POSITION_INVALID", [...keys, EMITTED_STEP_MEMBER],
          `'${EMITTED_STEP_MEMBER}' is the identity a template's '!for-each' gives a step it emits, written ` +
            `only by the expansion. Name the step with 'name:', or emit it from a '!for-each' in a template ` +
            `body's step list.`),
      );
    }
    if (typeof record.kind === "string" && !isResolvedReference(record)) {
      // A declaration: its own fields are measured from it, against its kind.
      const inner = this.cursorOf(record.kind);
      const declared: Place = {
        ...place,
        nested: false,
        declaration: { depth: keys.length, scopes: this.scopeFieldsOf(inner) },
      };
      for (const [key, field] of Object.entries(record)) {
        if (key === "kind" || key === "metadata") continue;
        this.visitField(key, field, keys, inner, declared);
      }
      return;
    }
    for (const [key, field] of Object.entries(record)) {
      this.visitField(key, field, keys, cursor, place);
    }
  }

  private visitField(
    key: string,
    value: unknown,
    keys: (string | number)[],
    cursor: Cursor,
    place: Place,
  ): void {
    if (key !== SPLICE) {
      this.visit(value, [...keys, key], childCursor(cursor, key), "field", place);
      return;
    }
    const at = [...keys, key];
    const entryCursor = mapValueCursor(cursor);
    if (!place.inTemplate) {
      this.record(value, at, "splice", place, "REPEAT_OUTSIDE_TEMPLATE",
        repeatOutsideMessage(`A '${SPLICE}' splice`), "splice");
      return;
    }
    const repeats = Array.isArray(value) ? value : [value];
    if (repeats.length === 0 || !repeats.every((v) => expansionTagOf(v) === "for-each")) {
      this.record(value, at, "splice", place, "REPEAT_POSITION_INVALID",
        `A '${SPLICE}' key holds a '!for-each' or a list of them, whose entries it splices into ` +
          `this mapping; here it holds something else. Write the entries as plain keys, or ` +
          `splice them with '!for-each'.`, "splice");
      return;
    }
    this.sites.push(siteOf(this.holder, at, "splice", "splice", place, value));
    if (Array.isArray(value)) {
      value.forEach((repeat, i) => this.visit(repeat, [...at, i], entryCursor, "splice", place));
    } else {
      this.visit(value, at, entryCursor, "splice", place);
    }
  }

  private visitTag(
    sentinel: ExpansionSentinel,
    keys: (string | number)[],
    cursor: Cursor,
    position: ExpansionPosition,
    place: Place,
  ): void {
    const tag = expansionTagOf(sentinel)!;
    const label = `'!${tag}'`;
    if (tag === "for-each") {
      if (!place.inTemplate) {
        this.record(sentinel, keys, position, place, "REPEAT_OUTSIDE_TEMPLATE", repeatOutsideMessage(label));
        return;
      }
      if (position === "field") {
        this.record(sentinel, keys, position, place, "REPEAT_POSITION_INVALID",
          `${label} at the value of a field: a repeat emits list items, a family's members, ` +
            `a splice's entries or steps, never one field's value. Put it in a list, or under a ` +
            `'${SPLICE}' key to emit entries of this mapping.`);
        return;
      }
    } else if (!place.branchAllowed) {
      this.record(sentinel, keys, position, place, "BRANCH_POSITION_INVALID", branchPositionMessage(label, this.holder));
      return;
    }

    const shape = shapeProblems(sentinel, tag, position, place.nested);
    if (shape.length > 0) {
      this.record(sentinel, keys, position, place, expansionShapeCode(tag), shape.join(" "));
    } else {
      this.sites.push(siteOf(this.holder, keys, tag, position, place, sentinel));
    }

    // Branches stand where the tag stands; an emitted item where its element
    // lands. A nested tag carries no `metadata` — the outermost holds the identity.
    const inner: Place = { ...place, nested: true };
    const body = sentinel as Record<string, unknown>;
    if (tag === "if") {
      for (const branch of ["then", "else"]) {
        if (branch in body) this.visit(body[branch], [...keys, branch], cursor, position, inner);
      }
    } else if (tag === "switch") {
      const cases = body.cases;
      if (cases && typeof cases === "object" && !Array.isArray(cases)) {
        for (const [key, branch] of Object.entries(cases as Record<string, unknown>)) {
          this.visit(branch, [...keys, "cases", key], cursor, position, inner);
        }
      }
      if ("default" in body) this.visit(body.default, [...keys, "default"], cursor, position, inner);
    } else {
      const emit = body.emit;
      const at = [...keys, "emit"];
      if (position === "splice") {
        this.visit(emit, at, cursor, "field", inner);
      } else if (Array.isArray(emit) && !DECLARATION_POSITIONS.has(position)) {
        emit.forEach((item, i) => this.visit(item, [...at, i], cursor, position, inner));
      } else {
        this.visit(emit, at, cursor, position, inner);
      }
    }
  }

  private record(
    value: unknown,
    keys: (string | number)[],
    position: ExpansionPosition,
    place: Place,
    code: string,
    message: string,
    construct?: "splice",
  ): void {
    const tag = expansionTagOf(value);
    this.sites.push({
      ...siteOf(this.holder, keys, construct ?? tag ?? "splice", position, place, value),
      refusal: code,
    });
    this.refused.push({ holder: this.holder, path: pathOf(keys) });
    this.diagnostics.push(this.diagnostic(code, keys, message));
  }

  private diagnostic(code: string, keys: (string | number)[], message: string): AnalysisDiagnostic {
    const metadata = this.holder.metadata as
      | { name?: unknown; source?: unknown; sourceLine?: unknown }
      | undefined;
    const name = typeof metadata?.name === "string" ? metadata.name : undefined;
    const kind = this.holder.kind ?? expansionTagLabel(this.holder);
    const path = pathOf(keys);
    const label = kind && name ? `${kind}/${name}: ` : "";
    const line = typeof metadata?.sourceLine === "number" ? metadata.sourceLine : undefined;
    // A whole-document tag carries no `metadata.name` to be found by: its line is its place.
    const range: Range | undefined =
      name === undefined && line !== undefined && keys.length === 0
        ? { start: { line, character: 0 }, end: { line, character: Number.MAX_SAFE_INTEGER } }
        : undefined;
    return {
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message: `${label}${message}`,
      ...(range ? { range } : {}),
      data: {
        ...(kind && name ? { resource: { kind, name } } : {}),
        ...(typeof metadata?.source === "string" ? { filePath: metadata.source } : {}),
        path,
      },
    };
  }

  /** Every `!ref` the grammar refuses beneath `value`, and — outside a template
   *  body, where no family is declared — every indexed one. */
  private scanRefs(value: unknown, keys: (string | number)[], inTemplate: boolean): void {
    if (isRefSentinel(value)) {
      const refusal = refSentinelRefusal(value);
      if (refusal) {
        this.refused.push({ holder: this.holder, path: pathOf(keys) });
        this.diagnostics.push(
          this.diagnostic("REF_MEMBER_INVALID", keys, refRefusalMessage(value.source, refusal)),
        );
      } else if (!inTemplate && (refSentinelTarget(value)?.indexes.length ?? 0) > 0) {
        this.refused.push({ holder: this.holder, path: pathOf(keys) });
        this.diagnostics.push(
          this.diagnostic("REF_MEMBER_INVALID", keys,
            `'!ref ${value.source}' indexes a family member, but a family is declared only inside a ` +
              `template body, where a loop's binding names the member; outside one there is nothing to ` +
              `index. Reference the resource by its name.`),
        );
      }
      return;
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => this.scanRefs(item, [...keys, i], inTemplate));
      return;
    }
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      this.scanRefs(field, [...keys, key], inTemplate);
    }
  }

  private isScopeField(keys: (string | number)[], place: Place): boolean {
    const declaration = place.declaration;
    if (!declaration || keys.length !== declaration.depth + 1) return false;
    const field = keys[declaration.depth];
    return typeof field === "string" && declaration.scopes.has(field);
  }

  private cursorOf(kind: string | undefined): Cursor {
    if (typeof kind !== "string") return NO_CURSOR;
    const definition = this.definitionOf(kind);
    const schema = (definition as { schema?: unknown } | undefined)?.schema;
    return schema && typeof schema === "object"
      ? { schema: schema as Record<string, any>, root: schema as Record<string, any> }
      : NO_CURSOR;
  }

  /** The named top-level properties a kind marks `x-telo-scope`. */
  private scopeFieldsOf(cursor: Cursor): ReadonlySet<string> {
    if (!cursor.schema) return new Set();
    const out = new Set<string>();
    for (const [key, property] of gatherPropertySchemas(cursor.schema, cursor.root)) {
      const node = resolveLocalRef(property, cursor.root ?? cursor.schema);
      if (node && "x-telo-scope" in node) out.add(key);
    }
    return out;
  }
}

/** The template body of a `Telo.Definition` beside its `resources:` entries:
 *  its boot list, its dispatch slots and their argument and result mappings. */
const TEMPLATE_BODY_FIELDS: ReadonlySet<string> = new Set([
  "targets",
  "invoke",
  "run",
  "provide",
  "mount",
  "inputs",
  "result",
]);

function siteOf(
  holder: ResourceManifest,
  keys: (string | number)[],
  construct: ExpansionTag | "splice",
  position: ExpansionPosition,
  place: Place,
  value: unknown,
): ExpansionSite {
  return {
    holder,
    path: pathOf(keys),
    construct,
    position,
    inTemplate: place.inTemplate,
    nested: place.nested,
    value,
  };
}

/** The fragment a tag's mapping is held to at a position. */
function fragmentFor(
  tag: ExpansionTag,
  position: ExpansionPosition,
  nested: boolean,
  body: Record<string, unknown>,
): string {
  const declaration = DECLARATION_POSITIONS.has(position) && !nested;
  if (tag === "if") return declaration ? "IfDeclaration" : "IfValue";
  if (tag === "switch") return declaration ? "SwitchDeclaration" : "SwitchValue";
  if (declaration) return "ForEachDeclaration";
  if (position === "splice") return "ForEachEntry";
  if (position === "step" && "name" in body) return "ForEachStepRepeat";
  return "ForEachValue";
}

const validators = new Map<string, (value: unknown) => boolean>();
const ajv = createAjv();

function validatorFor(fragment: string): ((value: unknown) => boolean) & { errors?: any[] | null } {
  const known = validators.get(fragment);
  if (known) return known as ((value: unknown) => boolean) & { errors?: any[] | null };
  const compiled = ajv.compile(manifestFragment(fragment));
  validators.set(fragment, compiled);
  return compiled as ((value: unknown) => boolean) & { errors?: any[] | null };
}

/** What is wrong with a tag's mapping at a position — empty when it fits. */
function shapeProblems(
  sentinel: ExpansionSentinel,
  tag: ExpansionTag,
  position: ExpansionPosition,
  nested: boolean,
): string[] {
  const body = expansionBody(sentinel);
  const fragment = fragmentFor(tag, position, nested, body);
  const validate = validatorFor(fragment);
  if (validate(body)) return [];
  const label = `'!${tag}'`;
  const declaration = DECLARATION_POSITIONS.has(position) && !nested;
  const problems = new Set<string>();
  for (const error of validate.errors ?? []) {
    const params = error.params as { additionalProperty?: string; missingProperty?: string };
    const path = String(error.instancePath ?? "");
    if (error.keyword === "additionalProperties" && path === "" && params.additionalProperty) {
      problems.add(extraKeyMessage(label, params.additionalProperty, tag, position, nested));
    } else if (error.keyword === "required" && path === "" && params.missingProperty) {
      problems.add(
        params.missingProperty === "metadata"
          ? `${label} at a declaration position (${describePosition(position)}) carries the ` +
              `declaration's 'metadata' — its name, written once for every branch.`
          : `${label} ${declaration ? "at this position " : ""}needs '${params.missingProperty}:'.`,
      );
    } else {
      problems.add(`${label}: '${path.slice(1).replace(/\//g, ".") || "(the mapping)"}' ${error.message}.`);
    }
  }
  return [...problems];
}

function extraKeyMessage(
  label: string,
  key: string,
  tag: ExpansionTag,
  position: ExpansionPosition,
  nested: boolean,
): string {
  if (key === "metadata") {
    return nested
      ? `${label} inside another tag's branch carries no 'metadata': the outermost tag holds the identity.`
      : `${label} at ${describePosition(position)} carries no 'metadata'; only a tag at a declaration ` +
          `position (a whole resource document, a template body's 'resources:' entry, an ` +
          `'x-telo-scope' member) names what it declares.`;
  }
  if (tag === "for-each" && key === "key") {
    return `The 'key:' of ${label} is written only on a repeat spliced under a '${SPLICE}' key, which it keys.`;
  }
  if (tag === "for-each" && key === "name") {
    return `The 'name:' of ${label} is written only on a repeat in a list of steps, whose results it names.`;
  }
  const keys =
    tag === "if" ? "'if', 'then', 'else'" : tag === "switch" ? "'switch', 'cases', 'default'" : "'in', 'as', 'emit'";
  return `${label} has no key '${key}'; it takes ${keys}.`;
}

function describePosition(position: ExpansionPosition): string {
  switch (position) {
    case "document":
      return "a whole resource document";
    case "template-resource":
      return "a template body's 'resources:' entry";
    case "scope-member":
      return "an 'x-telo-scope' member";
    case "module-target":
      return "an item of 'targets:'";
    case "step":
      return "an item of a step list";
    case "list-item":
      return "an item of a list";
    case "splice":
      return `a '${SPLICE}' splice`;
    case "field":
      return "the value of a field";
  }
}

function repeatOutsideMessage(construct: string): string {
  return (
    `${construct} outside a template body: a repeat's source is a consumer's literal data, which ` +
    `only a template receives. Write the items out, or move the repetition into a ` +
    `Telo.Definition's template body.`
  );
}

function branchPositionMessage(label: string, holder: ResourceManifest): string {
  if (isModuleKind(holder.kind)) {
    return (
      `${label} in a ${holder.kind} document outside 'targets:': the module document's imports, ` +
      `inputs and declarations are the same in every configuration — only an item of 'targets:' ` +
      `may be chosen. Choose inside a resource instead.`
    );
  }
  return (
    `${label} in a ${holder.kind} document outside its template body: a kind's schema, contract ` +
    `and grammar are the same in every configuration — only a template body's 'resources:', ` +
    `'targets:', dispatch slots and their 'inputs:' / 'result:' may be chosen.`
  );
}

function sourceOf(m: ResourceManifest): string | undefined {
  const source = (m.metadata as { source?: unknown } | undefined)?.source;
  return typeof source === "string" ? source : undefined;
}

/** `["steps", 0, "invoke"]` → `steps[0].invoke`. */
function pathOf(keys: readonly (string | number)[]): string {
  let out = "";
  for (const key of keys) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out.length === 0 ? key : `.${key}`;
  }
  return out;
}

function childCursor(cursor: Cursor, key: string | number): Cursor {
  if (!cursor.schema) return NO_CURSOR;
  const root = cursor.root ?? cursor.schema;
  const node = resolveLocalRef(cursor.schema, root);
  if (!node) return NO_CURSOR;
  if (typeof key === "number") {
    const items = firstOf(node, (n) => (n.items && typeof n.items === "object" && !Array.isArray(n.items) ? n.items : undefined), root);
    return items ? { schema: items, root } : NO_CURSOR;
  }
  const property = gatherPropertySchemas(node, root).find(([name]) => name === key)?.[1];
  if (property) return { schema: property, root };
  const patterns = node.patternProperties as Record<string, Record<string, any>> | undefined;
  if (patterns) {
    for (const [pattern, schema] of Object.entries(patterns)) {
      try {
        if (new RegExp(pattern, "u").test(key)) return { schema, root };
      } catch {
        // An unreadable pattern names nothing here; the schema's own check reports it.
      }
    }
  }
  return mapValueCursor({ schema: node, root });
}

function mapValueCursor(cursor: Cursor): Cursor {
  if (!cursor.schema) return NO_CURSOR;
  const root = cursor.root ?? cursor.schema;
  const node = resolveLocalRef(cursor.schema, root);
  const additional = node?.additionalProperties;
  return additional && typeof additional === "object" ? { schema: additional, root } : NO_CURSOR;
}

/** The first answer `pick` gives for the node or one of its union branches. */
function firstOf(
  node: Record<string, any>,
  pick: (n: Record<string, any>) => Record<string, any> | undefined,
  root: Record<string, any>,
): Record<string, any> | undefined {
  const direct = pick(node);
  if (direct) return direct;
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const resolved = branch && typeof branch === "object" ? resolveLocalRef(branch, root) : undefined;
      const found = resolved ? pick(resolved) : undefined;
      if (found) return found;
    }
  }
  return undefined;
}

/** True when the list at `cursor` holds steps of the shared step grammar. */
function isStepList(cursor: Cursor): boolean {
  if (!cursor.schema) return false;
  const root = cursor.root ?? cursor.schema;
  const node = resolveLocalRef(cursor.schema, root);
  if (!node) return false;
  if (readStepSlot(node)) return true;
  const items = node.items;
  return manifestFragmentOf(items) === STEP_FRAGMENT;
}

/**
 * Drops what other passes report about a refused construct: every diagnostic
 * about the same document at the construct's path or beneath it. The refusal is
 * the one report — a misplaced `!if` read as a mapping by the schema pass would
 * otherwise say the same defect again, in words pointing away from the repair.
 * A refused `schema:` of a definition also takes the template body with it.
 */
export function withoutRefusedExpansionConsequences(
  diagnostics: AnalysisDiagnostic[],
  reading: ExpansionReading,
): AnalysisDiagnostic[] {
  if (reading.refused.length === 0) return diagnostics;
  const own = new Set(reading.diagnostics);
  const keyOf = (kind: unknown, name: unknown, file: unknown) => `${kind}\0${name}\0${file}`;
  const paths = new Map<string, string[]>();
  const add = (key: string, path: string) => {
    const list = paths.get(key) ?? [];
    list.push(path);
    paths.set(key, list);
  };
  for (const { holder, path } of reading.refused) {
    const meta = holder.metadata as { name?: unknown; source?: unknown } | undefined;
    add(keyOf(holder.kind ?? expansionTagLabel(holder), meta?.name, meta?.source), path);
    // What is reported about a module doc's own entries may name no resource.
    if (isModuleKind(holder.kind)) add(keyOf(undefined, undefined, meta?.source), path);
    // A definition whose schema is refused has none the body can be read against,
    // so what the body reports about `self` is the refusal's consequence.
    if (holder.kind === "Telo.Definition" && isAtOrUnder(path, "schema")) {
      for (const field of ["resources", ...TEMPLATE_BODY_FIELDS]) add(keyOf(holder.kind, meta?.name, meta?.source), field);
    }
  }
  return diagnostics.filter((d) => {
    if (own.has(d)) return true;
    const data = d.data as
      | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
      | undefined;
    if (typeof data?.path !== "string") return true;
    const list = paths.get(keyOf(data.resource?.kind, data.resource?.name, data.filePath));
    return !list?.some((path) => isAtOrUnder(data.path as string, path));
  });
}

function isAtOrUnder(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}
