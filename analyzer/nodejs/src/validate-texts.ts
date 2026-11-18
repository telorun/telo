/**
 * The built-in text vocabulary at `telo check`.
 *
 * Over the entry's own modules (a dependency's manifests are its author's to fix;
 * the kernel refuses them at creation):
 *
 * - every literal `Text` judged as its writer wrote it — the module whose document
 *   holds it: a template body's entry and a `base:` mapping by the module declaring
 *   the definition, a value a template forwards with a bare `self.<path>` by the
 *   consumer, through the forward views the per-resource pipeline already checks
 *   (`MESSAGE_SYNTAX_INVALID`, `MESSAGE_SOURCE_LANGUAGE_MISSING`,
 *   `MESSAGE_PLURAL_CATEGORY_INVALID`);
 * - every `TextCatalog` judged whole (`MESSAGE_ENTRY_COMPUTED`,
 *   `MESSAGE_PLACEHOLDER_UNKNOWN`, `MESSAGE_PLURAL_CATEGORY_INVALID`,
 *   `MESSAGE_ENTRY_DUPLICATE`) — a kind whose whole schema is the fragment by
 *   what its resource writes beside `kind` and `metadata` — and each entry whose
 *   source no module of the catalog's import closure shows warned as
 *   `MESSAGE_TEXT_UNUSED`;
 * - an expression above a `TextCatalog` slot (`MESSAGE_ENTRY_COMPUTED`), but a
 *   bare `self.<path>` a template body or a `base:` mapping forwards;
 * - every keyed declaration and every resource of a keyed kind
 *   (`keyed-translations.ts`): the source language, each key's declared values,
 *   a catalog's plural categories against its own `lang`, computed entries;
 * - every values pairing a resource writes as a map (`MESSAGE_PLACEHOLDER_UNBOUND`,
 *   `MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED`);
 * - the two text annotations wherever a schema holds them (`SCHEMA_VIOLATION`,
 *   `TEXT_VALUES_FOR_INVALID`), and `x-telo-text-context` written anywhere but a
 *   data schema (`TEXT_CONTEXT_MISPLACED`, a warning).
 *
 * Over the whole application, what a served language would show untranslated
 * (`MESSAGE_TRANSLATION_MISSING`, a warning, `translation-coverage.ts`).
 *
 * A call's text arguments are judged where the call is (`validate-module-calls.ts`).
 *
 * THE ENUMERATION is the texts every module of the closure shows: each `Text` a
 * resource, a template body or a `base:` mapping writes, each `title`,
 * `description` and string enum value of a data schema, and each literal
 * argument at a `Text` parameter. One set per module, built once per analysis,
 * and one union per catalog's closure, memoized per module — linear in what the
 * closure writes. Browser-safe.
 */
import { listRequests, type DeclarationRequests } from "./declaration-requests.js";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { celExpressionsOf, isTaggedSentinel, writtenCalls } from "@telorun/templating";
import { resolveSignature } from "./callable-signature.js";
import { parseCelSource } from "./cel-environment.js";
import { hasOwnControllerOrTemplate, textKeysDeclarer } from "./extends-resolution.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  isKeyedTranslationsDoc,
  judgeKeyedCatalog,
  judgeKeyedDeclaration,
  keyedSetKind,
  keyedSetOf,
  keyedTranslationsOf,
} from "./keyed-translations.js";
import { isResolvedReference } from "./resolved-reference.js";
import { textKeysOf } from "./text-keys.js";
import {
  missingTranslations,
  missingTranslationsOver,
  servedLanguages,
  type CoverageLogic,
  type HeldMissing,
  type ShownKeyedSet,
  type ShownTexts,
  type TranslationLayer,
} from "./translation-coverage.js";
import { selfForwardPath } from "./template-forward.js";
import { isKindDocument } from "./kind-declaration.js";
import type { ModuleDocuments } from "./module-documents.js";
import { declaringModuleKey, ROOT_MODULE_KEY, SELF_ALIAS } from "./module-call-names.js";
import { isModuleKind } from "./module-kinds.js";
import { moduleLangOf, recordLangOf } from "./module-lang.js";
import {
  catalogComputedProblem,
  celTypeValueKind,
  describeTextKey,
  judgeCatalog,
  judgeMessage,
  judgeText,
  judgeValues,
  keyOfText,
  runtimeValueKind,
  type KnownValues,
  type MessageValueKind,
  type TextProblem,
} from "./text-judgement.js";
import {
  schemaNodes,
  schemaTexts,
  schemaValueSites,
  textAnnotationProblems,
  textContextNodes,
  textParameters,
} from "./text-schemas.js";
import {
  catalogsComputedAbove,
  expressionsWithin,
  isTextOrRecordUnion,
  producesTextRecord,
  renderValuePath,
  siteValueOf,
  TEXT_CONTEXT_ANNOTATION,
  textSites,
  type TextFragment,
  type TextWalk,
  type ValuePath,
} from "./text-slot.js";
import { BUILTIN_ERROR_TEXT_LANG, builtinErrorCodes, messageIdentity, readText, type Text } from "@telorun/sdk";
import { builtinTranslationCatalogs } from "./builtin-translations.js";
import { judgeDataValues, judgeDeclaredValues } from "./text-values.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

export type TextDefResolver = DefResolver;

type DefResolver = {
  (kind: string, from?: { metadata?: { module?: string } }): ResourceDefinition | undefined;
  in(kind: string, module?: string): ResourceDefinition | undefined;
};

export interface TextPassOptions {
  /** The flattened analysis set, forward views included. */
  readonly manifests: readonly ResourceManifest[];
  readonly rootModules: ReadonlySet<string>;
  readonly resolveDef: DefResolver;
  /** What each kind means along `extends`. */
  readonly kinds: Pick<DefinitionRegistry, "effectiveSchemaOf">;
  /** Every imported library's full documents. */
  readonly moduleDocuments: readonly ModuleDocuments[];
  /** The CEL names of each module (`moduleCallNamesByModule`). */
  readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  /** Resolves a named shape a kind's schema references. */
  readonly schemaForId: (id: string) => Record<string, any> | undefined;
  /** Whether a value satisfies a text fragment's schema. The core judges only a
   *  value the schema accepts: a fault the schema states is its one
   *  `SCHEMA_VIOLATION`. */
  readonly accepts: (fragment: TextFragment, value: unknown) => boolean;
  /** What the expression at `path` of `manifest` is checked to be, as a message's
   *  value: its CEL type, or the schema its chain reads. */
  readonly valueKindAt?: (
    manifest: ResourceManifest,
    path: string,
  ) => { kind: MessageValueKind; describe: string } | undefined;
  /** The schema the plain chain at `path` of `manifest` reads, when it is one. */
  readonly producedSchemaAt?: (manifest: ResourceManifest, path: string) => Record<string, any> | undefined;
  /** The declaration that wrote the value at `path` of `manifest` when it is not
   *  `manifest`'s own module — a template body's literal in a forward view. */
  readonly writerAt?: (manifest: ResourceManifest, path: string) => ResourceManifest | undefined;
  /** True when a template body wrote the value at `path` of `manifest` whole: its
   *  judgement is the defining module's own, made at the definition. */
  readonly bodyWroteWhole?: (manifest: ResourceManifest, path: string) => boolean;
}

const isExpression = (value: unknown): boolean => isTaggedSentinel(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function valueAt(container: unknown, path: ValuePath): unknown {
  let at = container;
  for (const key of path) at = at && typeof at === "object" ? (at as Record<string | number, unknown>)[key] : undefined;
  return at;
}

const libraryModules = new WeakMap<readonly ModuleDocuments[], readonly ResourceManifest[]>();

/** The module documents among each imported library's full documents, read
 *  once per list: every scope over one analysis reads the same list. */
function libraryModuleDocuments(documents: readonly ModuleDocuments[]): readonly ResourceManifest[] {
  let found = libraryModules.get(documents);
  if (!found) {
    found = documents.flatMap((doc) => doc.manifests).filter((m) => isModuleKind(m.kind as string));
    libraryModules.set(documents, found);
  }
  return found;
}

/**
 * Which module wrote a manifest, and what language that module writes in. An
 * entry-owned manifest carries no module stamp; with several entry modules it
 * is told apart by the file it was read from.
 */
export class TextLanguageScope {
  private readonly langs = new Map<string, string | null>();
  private readonly rootBySource = new Map<string, string>();

  constructor(
    declarations: DeclarationRequests,
    private readonly rootModules: ReadonlySet<string>,
    /** Each imported library's full documents. */
    documents: readonly ModuleDocuments[] = [],
  ) {
    for (const manifest of [...declarations.moduleDocuments(), ...libraryModuleDocuments(documents)]) {
      if (!isModuleKind(manifest.kind as string)) continue;
      const name = manifest.metadata?.name;
      if (typeof name !== "string") continue;
      if (!this.langs.has(name)) this.langs.set(name, moduleLangOf(manifest));
      const source = (manifest.metadata as { source?: unknown } | undefined)?.source;
      if (rootModules.has(name) && typeof source === "string") this.rootBySource.set(source, name);
    }
  }

  /** The module that wrote `manifest`. */
  moduleOf(manifest: ResourceManifest): string {
    const key = declaringModuleKey(manifest);
    if (key !== ROOT_MODULE_KEY) return key;
    const source = (manifest.metadata as { source?: unknown } | undefined)?.source;
    const bySource = typeof source === "string" ? this.rootBySource.get(source) : undefined;
    return bySource ?? [...this.rootModules][0] ?? ROOT_MODULE_KEY;
  }

  /** True for a manifest of the entry's own modules. */
  isOwned(manifest: ResourceManifest): boolean {
    const key = declaringModuleKey(manifest);
    return key === ROOT_MODULE_KEY || this.rootModules.has(key);
  }

  /** The `lang:` of a module, `null` when it declares none. */
  langOfModule(module: string): string | null {
    return this.langs.get(module) ?? null;
  }

  /** The `lang:` of the module that wrote `manifest`. */
  langOf(manifest: ResourceManifest): string | null {
    return this.langOfModule(this.moduleOf(manifest));
  }
}

interface Located {
  readonly manifest: ResourceManifest;
  readonly path: ValuePath;
}

function diagnostic(
  code: string,
  message: string,
  at: Located,
  severity: DiagnosticSeverity = DiagnosticSeverity.Error,
): AnalysisDiagnostic {
  const { manifest } = at;
  return {
    severity,
    code,
    source: SOURCE,
    message: `${manifest.kind}/${manifest.metadata?.name}: ${message}`,
    data: {
      resource: { kind: manifest.kind, name: manifest.metadata?.name },
      filePath: (manifest.metadata as { source?: string } | undefined)?.source,
      path: renderValuePath(at.path),
    },
  };
}

function problemDiagnostic(problem: Pick<TextProblem, "message" | "path"> & { code: string }, manifest: ResourceManifest, base: ValuePath, what: string) {
  const path = [...base, ...problem.path];
  return diagnostic(problem.code, `${what} at '${renderValuePath(path)}' is refused: ${problem.message}.`, {
    manifest,
    path,
  });
}

/** One place text is written, with the module that wrote it. */
interface TextWriting {
  /** The manifest diagnostics anchor on. */
  readonly manifest: ResourceManifest;
  /** Where in that manifest the walked value sits. */
  readonly base: ValuePath;
  /** The module that wrote the walked value. */
  readonly module: string;
  readonly walk: TextWalk;
  /** Its place among the manifest's writings. */
  readonly order: number;
  /** True for a template body entry or a `base:` mapping, where a bare
   *  `self.<path>` forwards the consumer's value. */
  readonly forwards?: boolean;
  /** What the walked value writes beside `kind` and `metadata`, when its kind
   *  translates a keyed set. */
  readonly keyedCatalog?: unknown;
}

/** What a reading of one manifest needs beside the manifest. */
export interface TextReaderOptions {
  readonly resolveDef: DefResolver;
  /** What each kind means along `extends`. */
  readonly kinds: Pick<DefinitionRegistry, "effectiveSchemaOf">;
  readonly scope: TextLanguageScope;
  /** The CEL names of each module (`moduleCallNamesByModule`). */
  readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  readonly schemaForId: TextPassOptions["schemaForId"];
  readonly accepts: TextPassOptions["accepts"];
  readonly valueKindAt?: TextPassOptions["valueKindAt"];
  readonly producedSchemaAt?: TextPassOptions["producedSchemaAt"];
  readonly writerAt?: TextPassOptions["writerAt"];
  readonly bodyWroteWhole?: TextPassOptions["bodyWroteWhole"];
  /** The parameters of what a qualified call written in `module` names. */
  readonly paramsOf: (qualified: string, module: string) => readonly { name?: unknown; schema?: unknown }[];
}

/** One finding of a reading, with its place among the manifest's findings: the
 *  writing it is found in, then that writing's section. */
export interface TextFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly order: readonly [number, number];
}

/** A text a module shows; `written` for a literal `Text` a translation counts. */
export interface ShownText {
  readonly module: string;
  readonly key: string;
  readonly written: boolean;
  /** Its place among the manifest's, as {@link TextFinding.order}. */
  readonly order: readonly [number, number];
}

/** A catalog a manifest holds, and the identity of each of its entries. */
export interface CatalogRead {
  readonly manifest: ResourceManifest;
  readonly module: string;
  readonly base: ValuePath;
  readonly entries: readonly { readonly index: number; readonly key: string }[];
  readonly order: readonly [number, number];
}

/** What reading one manifest's texts finds. */
export interface ManifestTexts {
  readonly findings: TextFinding[];
  /** The texts it shows, in order. */
  readonly shown: ShownText[];
  /** The texts its calls pass at `Text` parameters, which a run takes after
   *  every manifest's own. */
  readonly called: ShownText[];
  readonly catalogs: CatalogRead[];
  /** Every place of the manifest a judgement read. */
  readonly extents: ValuePath[];
}

/** Where the findings of a manifest's data schemas stand: after every writing. */
const SCHEMA_WRITING = Number.MAX_SAFE_INTEGER;

/** The place of a writing among a manifest's: its own value, what its `base:`
 *  chain forwards, each template body entry, its `base:` mapping. */
const WRITING_OF = { own: 0, forwarded: 1, entry: (index: number) => 2 + index, base: SCHEMA_WRITING - 1 };

/** The template body entry a writing's place (`order[0]` of a finding, a
 *  shown text or a catalog) is, by index; none for every other writing. */
export function bodyEntryOfWriting(writing: number): number | undefined {
  return writing >= WRITING_OF.entry(0) && writing < WRITING_OF.base ? writing - WRITING_OF.entry(0) : undefined;
}

/** A reader of one manifest's texts at a time. */
export function textReader(options: TextReaderOptions): (manifest: ResourceManifest, module: string, judged: boolean) => ManifestTexts {
  const { resolveDef, scope } = options;
  const resolveNamed = (ref: string) => {
    const schema = options.schemaForId(ref);
    return schema ? { schema, root: schema } : undefined;
  };
  const schemaOfKind = (kind: unknown, module: string): Record<string, any> | undefined => {
    if (typeof kind !== "string") return undefined;
    const definition = resolveDef.in(kind, module === ROOT_MODULE_KEY ? undefined : module);
    if (!definition) return undefined;
    const schema = options.kinds.effectiveSchemaOf(definition);
    return schema && typeof schema === "object" ? (schema as Record<string, any>) : undefined;
  };
  const walkOptions = { isExpression, resolveRef: resolveNamed };
  const resolveFrom = (kind: string, from: ResourceDefinition) => resolveDef.in(kind, from.metadata?.module);
  const definitionOf = (kind: unknown, module: string): ResourceDefinition | undefined =>
    typeof kind === "string" ? resolveDef.in(kind, module === ROOT_MODULE_KEY ? undefined : module) : undefined;
  /** True when `kind`, or a kind it extends, translates a keyed set. */
  const translatesKeys = (kind: unknown, module: string): boolean =>
    keyedSetOf(definitionOf(kind, module), resolveFrom) !== undefined;
  const keyedCatalogOf = (value: Record<string, unknown>, module: string) =>
    translatesKeys(value.kind, module) ? { keyedCatalog: siteValueOf({ path: [], value }) } : {};
  const walkOf = (schema: Record<string, any> | undefined, value: unknown): TextWalk =>
    schema ? textSites(schema, value, walkOptions) : { texts: [], values: [], expressions: [] };

  /**
   * What a `base:` chain hands the controller-bearing ancestor of `manifest`'s
   * kind, and which of it the consumer wrote: every value a mapping forwards with
   * a bare `self.<path>`, through every hop, linked to the consumer's path. A
   * literal a mapping writes is its declaring module's (judged with the mapping),
   * and any other expression is computed — neither is carried.
   */
  const baseForwardsOf = (manifest: ResourceManifest, module: string): TextWriting | undefined => {
    if (typeof manifest.kind !== "string") return undefined;
    let definition = resolveDef.in(manifest.kind, module === ROOT_MODULE_KEY ? undefined : module);
    let value: unknown = manifest;
    let links: { at: ValuePath; from: ValuePath }[] = [{ at: [], from: [] }];
    let mapped = false;
    const seen = new Set<object>();
    while (definition && !hasOwnControllerOrTemplate(definition) && !seen.has(definition)) {
      seen.add(definition);
      const { base, extends: parentKind } = definition as { base?: unknown; extends?: unknown };
      if (typeof parentKind !== "string") return undefined;
      if (isPlainObject(base)) {
        const next: { at: ValuePath; from: ValuePath }[] = [];
        const source = value;
        const materialize = (node: unknown, at: ValuePath): unknown => {
          const forwarded = selfForwardPath(node);
          if (forwarded) {
            const link = links.find((l) => l.at.every((segment, i) => forwarded[i] === segment));
            if (link) next.push({ at, from: [...link.from, ...forwarded.slice(link.at.length)] });
            let target: unknown = source;
            for (const key of forwarded) target = isPlainObject(target) ? target[key] : undefined;
            return target;
          }
          if (isExpression(node)) return undefined;
          if (Array.isArray(node)) return node.map((item, index) => materialize(item, [...at, index]));
          if (isPlainObject(node)) {
            const out: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(node)) {
              const materialized = materialize(child, [...at, key]);
              if (materialized !== undefined) out[key] = materialized;
            }
            return out;
          }
          return node;
        };
        value = materialize(base, []);
        links = next;
        mapped = true;
      }
      definition = resolveDef.in(parentKind, definition.metadata?.module);
    }
    if (!mapped || !definition || links.length === 0) return undefined;
    const schema = options.kinds.effectiveSchemaOf(definition) as Record<string, any> | undefined;
    if (!schema || typeof schema !== "object") return undefined;
    const walk = walkOf(schema, value);
    const consumerPath = (path: ValuePath): ValuePath | undefined => {
      const link = links
        .filter((l) => l.at.every((segment, i) => path[i] === segment))
        .sort((a, b) => b.at.length - a.at.length)[0];
      return link ? [...link.from, ...path.slice(link.at.length)] : undefined;
    };
    const texts = walk.texts.flatMap((site) => {
      const path = consumerPath(site.path);
      return path ? [{ ...site, path }] : [];
    });
    return texts.length > 0
      ? { manifest, base: [], module, order: WRITING_OF.forwarded, walk: { texts, values: [], expressions: [] } }
      : undefined;
  };

  /** Every place a module writes text: its resources, its template bodies, its
   *  `base:` mappings. */
  const writingsOf = (manifest: ResourceManifest, module: string): TextWriting[] => {
    if (isModuleKind(manifest.kind as string) || manifest.kind === "Telo.Import") return [];
    const out: TextWriting[] = [
      {
        manifest,
        base: [],
        module,
        order: WRITING_OF.own,
        walk: walkOf(schemaOfKind(manifest.kind, module), manifest),
        ...keyedCatalogOf(manifest as unknown as Record<string, unknown>, module),
      },
    ];
    const forwarded = baseForwardsOf(manifest, module);
    if (forwarded) out.push(forwarded);
    if (!isKindDocument(manifest)) return out;
    const definition = manifest as unknown as {
      resources?: unknown;
      base?: unknown;
      extends?: unknown;
    };
    if (Array.isArray(definition.resources)) {
      definition.resources.forEach((entry, index) => {
        if (!isPlainObject(entry)) return;
        out.push({
          manifest,
          base: ["resources", index],
          module,
          order: WRITING_OF.entry(index),
          walk: walkOf(schemaOfKind(entry.kind, module), entry),
          forwards: true,
          ...keyedCatalogOf(entry, module),
        });
      });
    }
    if (isPlainObject(definition.base) && typeof definition.extends === "string") {
      out.push({
        manifest,
        base: ["base"],
        module,
        order: WRITING_OF.base,
        walk: walkOf(schemaOfKind(definition.extends, module), definition.base),
        forwards: true,
      });
    }
    return out;
  };

  return (manifest, module, judged) => {
    const findings: TextFinding[] = [];
    const shown: ShownText[] = [];
    const called: ShownText[] = [];
    const catalogs: CatalogRead[] = [];
    const extents: ValuePath[] = [];
    const showText = (into: ShownText[], at: string, text: Text, order: readonly [number, number], counted = true) =>
      into.push({ module: at, key: keyOfText(text), written: counted && messageIdentity(text.message) !== "", order });
    const visit = (): void => {
      const lang = scope.langOfModule(module);
      // One value reached twice — typed by the kind and forwarded by its `base:` —
      // is judged once.
      const judgedPaths = new Set<string>();
      const bodyWrote = (place: ValuePath) => options.bodyWroteWhole?.(manifest, renderValuePath(place)) === true;
      if (judged && isKeyedTranslationsDoc(manifest)) {
        extents.push([]);
        for (const problem of judgeKeyedDeclaration(manifest, lang, isExpression)) {
          findings.push({ diagnostic: problemDiagnostic(problem, manifest, [], "the keyed text"), order: [-1, 0] });
        }
      }
      for (const writing of writingsOf(manifest, module)) {
        const found = (section: number, diagnostic: AnalysisDiagnostic) =>
          findings.push({ diagnostic, order: [writing.order, section] });
        if (judged && writing.keyedCatalog !== undefined) {
          extents.push(writing.base);
          for (const problem of judgeKeyedCatalog(writing.keyedCatalog, isExpression)) {
            if (bodyWrote([...writing.base, ...problem.path])) continue;
            found(0, problemDiagnostic(problem, manifest, writing.base, "the translation"));
          }
        }
        for (const site of writing.walk.texts) {
          const path = [...writing.base, ...site.path];
          const at = renderValuePath(path);
          if (judgedPaths.has(at)) continue;
          judgedPaths.add(at);
          extents.push(path);
          if (site.valuesFrom) extents.push([...writing.base, ...site.valuesFrom.path]);
          const bodyWritten = (place: string) => options.bodyWroteWhole?.(manifest, place) === true;
          if (site.fragment === "TextCatalog") {
            if (!judged || bodyWritten(at)) continue;
            const catalog = siteValueOf(site);
            // A bare `self.<path>` a template body or a `base:` mapping writes hands
            // on what the consumer wrote, judged where the consumer wrote it.
            if (writing.forwards && selfForwardPath(catalog)) continue;
            if (expressionsWithin(catalog, isExpression).length === 0 && !options.accepts(site.fragment, catalog)) {
              continue;
            }
            const result = judgeCatalog(catalog, isExpression);
            for (const problem of result.problems) {
              found(1, problemDiagnostic(problem, manifest, path, "the text catalog entry"));
            }
            catalogs.push({ manifest: writing.manifest, module: writing.module, base: path, entries: result.entries, order: [writing.order, 1] });
            continue;
          }
          if (expressionsWithin(site.value, isExpression).length > 0) continue;
          if (!options.accepts(site.fragment, site.value)) continue;
          // What a body wrote whole is judged at its definition; the data a text's
          // values come from may still be the consumer's.
          const own = bodyWritten(at);
          const ownValues =
            own && !!site.valuesFrom && bodyWritten(renderValuePath([...writing.base, ...site.valuesFrom.path]));
          if (site.fragment === "Message") {
            if (!judged) continue;
            const read = judgeMessage(site.value);
            if (!own) {
              for (const problem of read.problems) found(1, problemDiagnostic(problem, manifest, path, "the message"));
            }
            if (!own && read.message && site.declaredValues) {
              for (const problem of judgeDeclaredValues(read.message, site.declaredValues)) {
                found(1, problemDiagnostic(problem, manifest, path, "the message"));
              }
            }
            if (read.message && site.valuesFrom && !ownValues) {
              for (const problem of judgeDataValues(read.message, site.valuesFrom.schema, [...writing.base, ...site.valuesFrom.path])) {
                found(1, problemDiagnostic(problem, manifest, path, "the message"));
              }
            }
            continue;
          }
          const writer = options.writerAt?.(manifest, at);
          const writtenIn = writer ? scope.moduleOf(writer) : module;
          const text = judgeText(site.value, writer ? scope.langOfModule(writtenIn) : lang);
          // A kind's declared display messages count only for a kind some
          // declaration instantiates (see `instantiatedThrowsTexts`).
          const kindThrows = isKindDocument(manifest) && writing.base.length === 0 && site.path[0] === "throws";
          if (text.text) showText(shown, writtenIn, text.text, [writing.order, 1], !kindThrows);
          if (!judged) continue;
          if (!own) {
            for (const problem of text.problems) found(1, problemDiagnostic(problem, manifest, path, "the text"));
          }
          if (!own && text.text && site.declaredValues) {
            for (const problem of judgeDeclaredValues(text.text.message, site.declaredValues)) {
              found(1, problemDiagnostic(problem, manifest, path, "the text"));
            }
          }
          if (text.text && site.valuesFrom && !ownValues) {
            for (const problem of judgeDataValues(text.text.message, site.valuesFrom.schema, [...writing.base, ...site.valuesFrom.path])) {
              found(1, problemDiagnostic(problem, manifest, path, "the text"));
            }
          }
        }
        if (judged) {
          // An expression at a slot taking a literal text or a record is admitted
          // by the record branch alone.
          for (const expression of writing.walk.expressions) {
            if (!isTextOrRecordUnion(expression.schema, expression.root, walkOptions.resolveRef)) continue;
            const at = [...writing.base, ...expression.path];
            extents.push(at);
            if (writing.forwards && selfForwardPath(valueAt(manifest, at))) continue;
            const produced = options.producedSchemaAt?.(manifest, renderValuePath(at));
            if (produced && producesTextRecord(produced, produced, walkOptions.resolveRef)) continue;
            found(
              2,
              diagnostic(
                "TEXT_ARGUMENT_COMPUTED",
                `the value at '${renderValuePath(at)}' is computed, and this slot takes a literal text or the record of a text already shown (\`!cel "error.displayMessage"\`): a text an expression produces can be neither checked nor translated. Write the text itself, with its values beside it`,
                { manifest, path: at },
              ),
            );
          }
        }
        if (!judged) continue;
        // A bare `self.<path>` a template body or a `base:` mapping writes hands on
        // what the consumer wrote, judged where the consumer wrote it.
        for (const path of catalogsComputedAbove(writing.walk, walkOptions)) {
          const at = [...writing.base, ...path];
          extents.push(at);
          if (writing.forwards && selfForwardPath(valueAt(manifest, at))) continue;
          found(3, problemDiagnostic(catalogComputedProblem(), manifest, at, "the value"));
        }
        for (const pairing of writing.walk.values) {
          const path = [...writing.base, ...pairing.path];
          extents.push(path, [...writing.base, ...pairing.textPath]);
          if (
            !isPlainObject(pairing.values) ||
            isExpression(pairing.values) ||
            expressionsWithin(pairing.text, isExpression).length > 0
          ) {
            continue;
          }
          const read = readText(pairing.text);
          if (!read.ok) continue;
          // A value written as an expression is what the checker typed it — an
          // accessor's chain as much as an evaluated one.
          const known: KnownValues = new Map(
            Object.entries(pairing.values).map(([key, value]) => [
              key,
              isExpression(value)
                ? (options.valueKindAt?.(manifest, renderValuePath([...path, key])) ?? celTypeValueKind(undefined))
                : runtimeValueKind(value),
            ]),
          );
          for (const problem of judgeValues(read.text.message, known)) {
            found(
              4,
              problemDiagnostic(problem, manifest, path, `the values for the text at '${renderValuePath([...writing.base, ...pairing.textPath])}'`),
            );
          }
        }
      }
    };

    /** The data schemas a manifest holds — their texts are the module's, and their
     *  annotations are judged where they are written. */
    const visitSchemas = (): void => {
      if (isModuleKind(manifest.kind as string)) {
        if (judged) misplaced(new Set());
        return;
      }
      const sites = schemaValueSites(schemaOfKind(manifest.kind, module), manifest, isExpression);
      const dataNodes = new Set<object>();
      for (const site of sites) {
        extents.push(site.path);
        if (site.role === "data") {
          for (const text of schemaTexts(site.value)) shown.push({ module, key: text.key, written: false, order: [SCHEMA_WRITING, 0] });
          for (const { node } of schemaNodes(site.value)) dataNodes.add(node);
        }
        if (!judged) continue;
        for (const problem of textAnnotationProblems(site)) {
          const path = [...site.path, ...problem.path];
          findings.push({ diagnostic: diagnostic(problem.code, `${problem.message}.`, { manifest, path }), order: [SCHEMA_WRITING, 0] });
        }
      }
      if (judged) misplaced(dataNodes);
    };

    const misplaced = (dataNodes: ReadonlySet<object>): void => {
      for (const { node, path } of textContextNodes(manifest)) {
        extents.push(path);
        if (dataNodes.has(node)) continue;
        findings.push({
          diagnostic: diagnostic(
            "TEXT_CONTEXT_MISPLACED",
            `${TEXT_CONTEXT_ANNOTATION} is read only on a data schema — a named shape, a status block, a contract, a callable's parameters and result, or a schema written at a 'use: schema' slot — where it gives the context of the node's title, description and enum labels. Here nothing reads it.`,
            { manifest, path: [...path, TEXT_CONTEXT_ANNOTATION] },
            DiagnosticSeverity.Warning,
          ),
          order: [SCHEMA_WRITING, 1],
        });
      }
    };

    visit();
    visitSchemas();
    // Literal text arguments at `Text` parameters, read off the module's own CEL.
    const names = options.moduleCallNames.get(module) ?? options.moduleCallNames.get(ROOT_MODULE_KEY);
    if (names) {
      for (const source of celSourcesOf(manifest)) {
        const parsed = parseCelSource(source, names);
        if (!parsed) continue;
        for (const call of writtenCalls(parsed.root)) {
          const params = options.paramsOf(call.qualified, module);
          for (const parameter of textParameters(params)) {
            const argument = call.arguments[parameter.index];
            if (!argument?.literal) continue;
            const read = readText(argument.value);
            if (read.ok) showText(called, module, read.text, [0, 0]);
          }
        }
      }
    }
    return { findings, shown, called, catalogs, extents };
  };
}

/** MESSAGE_TEXT_UNUSED for one entry of a catalog. */
export function unusedTextDiagnostic(catalog: CatalogRead, index: number): AnalysisDiagnostic {
  const path = [...catalog.base, "texts", index, "text"];
  return diagnostic(
    "MESSAGE_TEXT_UNUSED",
    `the text at '${renderValuePath(path)}' is shown by no module this catalog's module imports, directly or through others, so its translation is never used. Correct the text and context to match the source exactly, or import the module whose texts this catalog translates.`,
    { manifest: catalog.manifest, path },
    DiagnosticSeverity.Warning,
  );
}

/** What an application's coverage is read from, in one configuration. */
export interface CoverageInputs {
  readonly application: ResourceManifest;
  /** The application's module and every module it imports, in reach order. */
  readonly modules: ReadonlySet<string>;
  /** The literal texts each module writes, in order. */
  readonly written: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every kind a declaration of `modules` instantiates, in walk order. */
  readonly kinds: readonly InstantiatedKind[];
  /** The listed catalogs, in list order, each as the layer it adds. */
  readonly listed: readonly TranslationLayer[];
}

/** What the coverage of an application reads, rule by rule — the same over one
 *  configuration's declarations and over every configuration's. */
export function textCoverage(resolveDef: DefResolver, scope: TextLanguageScope) {
  const resolveFrom = (kind: string, from: ResourceDefinition) => resolveDef.in(kind, from.metadata?.module);
  const definitionOf = (kind: unknown, module: string): ResourceDefinition | undefined =>
    typeof kind === "string" ? resolveDef.in(kind, module === ROOT_MODULE_KEY ? undefined : module) : undefined;

  /** The layer a listed catalog adds: none for one whose `lang` is not literal
   *  — its reference and its schema are judged where they are written. */
  const layerOf = (declared: { manifest: ResourceManifest; module: string }): TranslationLayer | undefined => {
    const { kind, metadata, ...configuration } = declared.manifest as unknown as Record<string, unknown>;
    const lang = configuration.lang;
    if (typeof lang !== "string" || lang === "") return undefined;
    const set = keyedSetOf(definitionOf(kind, declared.module), resolveFrom);
    if (set) {
      const messages = configuration.messages;
      const keys = new Set(isPlainObject(messages) ? Object.keys(messages) : []);
      return { lang, texts: new Set(), keyed: new Map([[keyedSetKind(set), keys]]) };
    }
    const entries = judgeCatalog(configuration, isExpression).entries;
    return { lang, texts: new Set(entries.map((entry) => entry.key)), keyed: new Map() };
  };

  /** The display messages of the kinds `kinds` instantiate: each kind's own
   *  `throws.codes` and its ancestors', the nearest declaration winning per
   *  code, grouped by the language of the module that wrote them. */
  const instantiatedThrowsTexts = (kinds: readonly InstantiatedKind[]): ShownTexts[] => {
    const byLang = new Map<string, Set<string>>();
    const seenKinds = new Set<string>();
    for (const { kind, module } of kinds) {
      const codes = new Set<string>();
      const visited = new Set<ResourceDefinition>();
      let definition = definitionOf(kind, module);
      while (definition && !visited.has(definition)) {
        visited.add(definition);
        const declared = (definition as { throws?: { codes?: unknown } }).throws?.codes;
        const definitionModule = definition.metadata?.module;
        if (isPlainObject(declared)) {
          for (const [code, entry] of Object.entries(declared)) {
            if (codes.has(code)) continue;
            codes.add(code);
            if (!isPlainObject(entry)) continue;
            const read = readText(entry.displayMessage);
            if (!read.ok || messageIdentity(read.text.message) === "") continue;
            const lang = recordLangOf(typeof definitionModule === "string" ? scope.langOfModule(definitionModule) : null);
            const memo = `${lang}\0${keyOfText(read.text)}`;
            if (seenKinds.has(memo)) continue;
            seenKinds.add(memo);
            let set = byLang.get(lang);
            if (!set) byLang.set(lang, (set = new Set()));
            set.add(keyOfText(read.text));
          }
        }
        const parent = (definition as { extends?: unknown }).extends;
        definition = typeof parent === "string" ? resolveDef.in(parent, definition.metadata?.module) : undefined;
      }
    }
    return [...byLang].map(([lang, keys]) => ({ lang, keys }));
  };

  /** Every keyed set a declaration of `kinds` shows through its kind's
   *  `x-telo-text-keys`. */
  const shownKeyedSets = (kinds: readonly InstantiatedKind[]): ShownKeyedSet[] => {
    const sets = new Map<string, ShownKeyedSet>();
    for (const { kind, module } of kinds) {
      const declarer = textKeysDeclarer(definitionOf(kind, module), resolveDef);
      if (!declarer) continue;
      for (const named of textKeysOf(declarer.schema)) {
        const set = keyedSetOf(resolveDef.in(named, declarer.metadata?.module), resolveFrom);
        const shape = keyedTranslationsOf(set);
        if (!set || !shape) continue;
        const id = keyedSetKind(set);
        if (sets.has(id)) continue;
        const setModule = set.metadata?.module;
        sets.set(id, {
          set: id,
          lang: recordLangOf(typeof setModule === "string" ? scope.langOfModule(setModule) : null),
          keys: Object.keys(shape.keys),
        });
      }
    }
    return [...sets.values()];
  };

  /**
   * MESSAGE_TRANSLATION_MISSING over the whole application: every keyed set a
   * resource of its closure shows and every `Text` its closure writes, held to
   * the layered result of its listed catalogs in each served language.
   */
  const missingTranslationDiagnostics = (input: CoverageInputs): { lang: string; set?: string; diagnostic: AnalysisDiagnostic }[] => {
    const { application } = input;
    // The built-in catalogs lie beneath every listed one and serve no language.
    const served = servedLanguages(
      recordLangOf(moduleLangOf(application)),
      input.listed.map((layer) => layer.lang),
    );
    const layers = [...builtinTranslationLayers(), ...input.listed];
    const texts: ShownTexts[] = [
      { lang: BUILTIN_ERROR_TEXT_LANG, keys: builtinShownTexts() },
      ...[...input.modules].flatMap((module) => {
        const keys = input.written.get(module);
        return keys ? [{ lang: recordLangOf(scope.langOfModule(module)), keys }] : [];
      }),
      ...instantiatedThrowsTexts(input.kinds),
    ];
    const findings = missingTranslations({ served, layers, texts, keyedSets: shownKeyedSets(input.kinds) });
    const path = Object.hasOwn(application, "translations") ? ["translations"] : ["lang"];
    return findings.map(({ lang, set, missing }) => ({
      lang,
      ...(set !== undefined ? { set } : {}),
      diagnostic: diagnostic(
        "MESSAGE_TRANSLATION_MISSING",
        set === undefined
          ? `'${lang}' is served, but nothing translates ${missing.length === 1 ? "this text" : `these ${missing.length} texts`} into it, so each shows in the language it is written in: ${missing.map(describeTextKey).join(", ")}. Translate them in a Telo.TextTranslations catalog of lang '${lang}' listed under translations.catalogs.`
          : `'${lang}' is served, but nothing translates ${missing.length === 1 ? "this key" : `these ${missing.length} keys`} of '${set}' into it, so each shows its source wording: ${missing.join(", ")}. List a catalog of '${set}' in lang '${lang}' under translations.catalogs that translates them.`,
        { manifest: application, path },
        DiagnosticSeverity.Warning,
      ),
    }));
  };

  /** What the coverage reads over every configuration at once, each part with
   *  where it holds: the served languages, the layers, the texts and keyed sets
   *  shown — what tells the entries a configuration can report and the items
   *  each may list. */
  const heldCoverage = <T>(
    logic: CoverageLogic<T>,
    input: {
      readonly application: ResourceManifest;
      readonly modules: ReadonlySet<string>;
      readonly written: ReadonlyMap<string, ReadonlyMap<string, T>>;
      readonly kinds: readonly (InstantiatedKind & { readonly held: T })[];
      readonly listed: readonly (TranslationLayer & { readonly held: T })[];
    },
  ): HeldMissing<T>[] => {
    const served = [
      { lang: recordLangOf(moduleLangOf(input.application)), held: logic.TRUE },
      ...input.listed.map((layer) => ({ lang: layer.lang, held: layer.held })),
    ];
    const layers = [...builtinTranslationLayers().map((layer) => ({ ...layer, held: logic.TRUE })), ...input.listed];
    const throwsTexts = new Map<string, Map<string, T>>();
    const keyedSets = new Map<string, ShownKeyedSet & { held: T }>();
    for (const kind of input.kinds) {
      for (const group of instantiatedThrowsTexts([kind])) {
        let keys = throwsTexts.get(group.lang);
        if (!keys) throwsTexts.set(group.lang, (keys = new Map()));
        for (const key of group.keys) keys.set(key, logic.or(keys.get(key) ?? logic.FALSE, kind.held));
      }
      for (const set of shownKeyedSets([kind])) {
        const known = keyedSets.get(set.set);
        keyedSets.set(set.set, known ? { ...known, held: logic.or(known.held, kind.held) } : { ...set, held: kind.held });
      }
    }
    return missingTranslationsOver(logic, {
      served,
      layers,
      texts: [
        { lang: BUILTIN_ERROR_TEXT_LANG, keys: new Map([...builtinShownTexts()].map((key) => [key, logic.TRUE])) },
        ...[...input.modules].flatMap((module) => {
          const keys = input.written.get(module);
          return keys ? [{ lang: recordLangOf(scope.langOfModule(module)), keys }] : [];
        }),
        ...[...throwsTexts].map(([lang, keys]) => ({ lang, keys })),
      ],
      keyedSets: [...keyedSets.values()],
    });
  };

  return { layerOf, missingTranslationDiagnostics, heldCoverage };
}

export function validateTexts(options: TextPassOptions): AnalysisDiagnostic[] {
  const { manifests, rootModules, resolveDef, moduleDocuments } = options;
  const scope = new TextLanguageScope(listRequests(manifests), rootModules, moduleDocuments);
  const callees = new CalleeResolver(manifests, moduleDocuments, scope, resolveDef);
  const read = textReader({ ...options, scope, paramsOf: (qualified, module) => callees.paramsOf(qualified, module) });
  const coverage = textCoverage(resolveDef, scope);

  // The texts each module shows, and the literal `Text` values each writes — a
  // data schema's labels and an empty text, which nothing translates, aside.
  const shown = new Map<string, Set<string>>();
  const written = new Map<string, Set<string>>();
  const record = (texts: readonly ShownText[]) => {
    for (const text of texts) {
      addTo(shown, text.module, text.key);
      if (text.written) addTo(written, text.module, text.key);
    }
  };
  const diagnostics: AnalysisDiagnostic[] = [];
  const catalogs: CatalogRead[] = [];
  const called: ShownText[] = [];
  const take = (found: ManifestTexts) => {
    diagnostics.push(...found.findings.map((f) => f.diagnostic));
    record(found.shown);
    catalogs.push(...found.catalogs);
    called.push(...found.called);
  };

  // The entry's own manifests and the forward views (declared in the consumer's
  // module), judged and enumerated; a library's, enumerated from its full
  // documents where the analysis holds them, else from what the flattened set
  // forwards of it.
  const documented = new Set(moduleDocuments.map((doc) => doc.module));
  for (const manifest of manifests) {
    const owned = scope.isOwned(manifest);
    const module = scope.moduleOf(manifest);
    if (!owned && documented.has(module)) continue;
    take(read(manifest, module, owned));
  }
  for (const library of moduleDocuments) {
    for (const manifest of library.manifests) take(read(manifest, library.module, false));
  }
  record(called);

  // MESSAGE_TEXT_UNUSED: a catalog key no module of its closure shows.
  const closure = new ClosureTexts(manifests, scope, shown);
  for (const catalog of catalogs) {
    const texts = closure.of(catalog.module);
    for (const entry of catalog.entries) {
      if (!texts.has(entry.key)) diagnostics.push(unusedTextDiagnostic(catalog, entry.index));
    }
  }

  const application = manifests.find((m) => m.kind === "Telo.Application" && scope.isOwned(m));
  if (application) {
    const appModule = scope.moduleOf(application);
    const modules = closure.reach(appModule);
    const kinds = new KindWalk();
    for (const manifest of manifests) {
      const module = scope.moduleOf(manifest);
      if (modules.has(module)) kinds.walk(manifest, module);
    }
    for (const library of moduleDocuments) {
      if (!modules.has(library.module)) continue;
      for (const manifest of library.manifests) kinds.walk(manifest, library.module);
    }
    diagnostics.push(
      ...coverage
        .missingTranslationDiagnostics({
          application,
          modules,
          written,
          kinds: kinds.found(),
          listed: listedCatalogLayers(application, appModule),
        })
        .map((found) => found.diagnostic),
    );
  }
  return diagnostics;

  /** The listed catalogs, in list order, each as the layer it adds. A catalog
   *  that names nothing, or whose `lang` is not literal, adds none — its
   *  reference and its schema are judged where they are written. A catalog whose
   *  `lang` is computed adds no layer, so coverage can only be under-reported. */
  function listedCatalogLayers(application: ResourceManifest, appModule: string): TranslationLayer[] {
    const listed = (application as { translations?: { catalogs?: unknown } }).translations?.catalogs;
    if (!Array.isArray(listed)) return [];
    const importTargets = new Map<string, string>();
    for (const m of manifests) {
      const target = (m.metadata as { resolvedModuleName?: unknown } | undefined)?.resolvedModuleName;
      if (m.kind === "Telo.Import" && typeof target === "string" && scope.moduleOf(m) === appModule) {
        importTargets.set(String(m.metadata?.name), target);
      }
    }
    return listed.flatMap((reference): TranslationLayer[] => {
      const declared = listedCatalog(manifests, scope, reference, appModule, importTargets);
      const layer = declared && coverage.layerOf(declared);
      return layer ? [layer] : [];
    });
  }
}

/** The declaration a `translations.catalogs` reference names among
 *  `manifests`: the application's own resource, or an instance an import
 *  exports. */
export function listedCatalog(
  manifests: readonly ResourceManifest[],
  scope: TextLanguageScope,
  reference: unknown,
  appModule: string,
  importTargets: ReadonlyMap<string, string>,
): { manifest: ResourceManifest; module: string } | undefined {
  if (!isResolvedReference(reference)) return undefined;
  if (reference.alias === undefined) {
    const manifest = manifests.find(
      (m) =>
        m.metadata?.name === reference.name &&
        scope.isOwned(m) &&
        scope.moduleOf(m) === appModule &&
        m.kind !== "Telo.Import" &&
        !isModuleKind(m.kind as string) &&
        !isKindDocument(m),
    );
    return manifest && { manifest, module: appModule };
  }
  const target = importTargets.get(reference.alias);
  if (target === undefined) return undefined;
  const manifest = manifests.find((m) => {
    const meta = m.metadata as { module?: unknown; forwardedExport?: unknown; name?: unknown } | undefined;
    return meta?.module === target && meta.forwardedExport === true && meta.name === reference.name;
  });
  return manifest && { manifest, module: target };
}

function addTo(into: Map<string, Set<string>>, module: string, key: string): void {
  let set = into.get(module);
  if (!set) into.set(module, (set = new Set()));
  set.add(key);
}

/** Every kind a declaration instantiates — top-level, inline at any depth, or a
 *  template body's entry; a kind's own schema declares no instance — in the
 *  order a walk of the declarations meets them, each once. */
export class KindWalk {
  private readonly kinds = new Map<string, InstantiatedKind>();
  private readonly seen = new Set<object>();

  walk(value: unknown, module: string): void {
    if (!value || typeof value !== "object" || this.seen.has(value) || isExpression(value)) return;
    this.seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item, module);
      return;
    }
    if (!isPlainObject(value)) return;
    if (typeof value.kind === "string" && !isResolvedReference(value)) {
      if (isKindDocument(value as unknown as ResourceManifest)) {
        this.walk(value.resources, module);
        return;
      }
      this.kinds.set(`${module}\0${value.kind}`, { kind: value.kind, module });
    }
    for (const [key, child] of Object.entries(value)) {
      // An annotation names kinds; it declares nothing.
      if (!key.startsWith("x-telo-")) this.walk(child, module);
    }
  }

  found(): InstantiatedKind[] {
    return [...this.kinds.values()];
  }
}

export interface InstantiatedKind {
  kind: string;
  module: string;
}

/** The CEL sources a manifest's values hold, in plain containers. */
function celSourcesOf(value: unknown): string[] {
  if (isTaggedSentinel(value)) {
    const { engine, source } = value as { engine: string; source: string };
    return typeof source === "string" ? celExpressionsOf(engine, source) : [];
  }
  if (Array.isArray(value)) return value.flatMap(celSourcesOf);
  if (isPlainObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).flatMap(celSourcesOf);
  }
  return [];
}

/** What a qualified call names, by the calling module's own names and imports —
 *  read for the parameters it declares, never judged. */
export class CalleeResolver {
  private readonly imports = new Map<string, string>();
  private readonly declarations = new Map<string, ResourceManifest>();

  constructor(
    manifests: readonly ResourceManifest[],
    documents: readonly ModuleDocuments[],
    private readonly scope: TextLanguageScope,
    private readonly resolveDef: DefResolver,
  ) {
    for (const manifest of manifests) {
      const name = manifest.metadata?.name;
      if (typeof name !== "string") continue;
      const module = scope.moduleOf(manifest);
      if (manifest.kind === "Telo.Import") {
        const target = (manifest.metadata as { resolvedModuleName?: unknown }).resolvedModuleName;
        if (typeof target === "string") this.imports.set(`${module}\0${name}`, target);
        continue;
      }
      this.declarations.set(`${module}\0${name}`, manifest);
    }
    for (const library of documents) {
      for (const manifest of library.manifests) {
        const name = manifest.metadata?.name;
        if (typeof name === "string" && manifest.kind !== "Telo.Import") {
          this.declarations.set(`${library.module}\0${name}`, manifest);
        }
      }
    }
  }

  paramsOf(qualified: string, module: string): readonly { name?: unknown; schema?: unknown }[] {
    const dot = qualified.indexOf(".");
    const receiver = qualified.slice(0, dot);
    const name = qualified.slice(dot + 1);
    const target =
      receiver === SELF_ALIAS || receiver === module ? module : this.imports.get(`${module}\0${receiver}`);
    if (!target) return [];
    const declaration = this.declarations.get(`${target}\0${name}`);
    if (!declaration || typeof declaration.kind !== "string") return [];
    const definition = this.resolveDef.in(declaration.kind, target);
    return (
      resolveSignature(declaration, definition, (kind) => this.resolveDef.in(kind, target)).params ?? []
    );
  }
}

let builtinShown: ReadonlySet<string> | undefined;

/** The built-in texts — the ambient error codes' — which every module shows,
 *  since the runtime attaches them to failures any module's dispatch raises. */
export function builtinShownTexts(): ReadonlySet<string> {
  builtinShown ??= new Set(
    builtinErrorCodes().flatMap((entry) => {
      const read = readText(entry.displayMessage);
      return read.ok ? [keyOfText(read.text)] : [];
    }),
  );
  return builtinShown;
}

let builtinLayers: readonly TranslationLayer[] | undefined;

/** The built-in catalogs as layers, the lowest of every application's set. */
function builtinTranslationLayers(): readonly TranslationLayer[] {
  builtinLayers ??= builtinTranslationCatalogs().map(({ lang, catalog }) => ({
    lang,
    texts: new Set(judgeCatalog(catalog, () => false).entries.map((entry) => entry.key)),
    keyed: new Map(),
  }));
  return builtinLayers;
}

/** The texts a module's whole import closure shows, memoized per module. */
export class ClosureTexts {
  private readonly edges = new Map<string, Set<string>>();
  private readonly memo = new Map<string, Set<string>>();

  constructor(
    manifests: readonly ResourceManifest[],
    scope: TextLanguageScope,
    private readonly shown: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    for (const manifest of manifests) {
      if (manifest.kind !== "Telo.Import") continue;
      const target = (manifest.metadata as { resolvedModuleName?: unknown }).resolvedModuleName;
      if (typeof target !== "string") continue;
      const from = scope.moduleOf(manifest);
      let set = this.edges.get(from);
      if (!set) this.edges.set(from, (set = new Set()));
      set.add(target);
    }
  }

  of(module: string): ReadonlySet<string> {
    const cached = this.memo.get(module);
    if (cached) return cached;
    const texts = new Set<string>(builtinShownTexts());
    for (const reached of this.reach(module)) {
      for (const key of this.shown.get(reached) ?? []) texts.add(key);
    }
    this.memo.set(module, texts);
    return texts;
  }

  /** `module` and every module it imports, directly or through others. */
  reach(module: string): ReadonlySet<string> {
    const seen = new Set<string>();
    const pending = [module];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const target of this.edges.get(next) ?? []) pending.push(target);
    }
    return seen;
  }
}
