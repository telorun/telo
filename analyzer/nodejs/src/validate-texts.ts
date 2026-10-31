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
 * - every values pairing a resource writes as a map (`MESSAGE_PLACEHOLDER_UNBOUND`,
 *   `MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED`);
 * - the two text annotations wherever a schema holds them (`SCHEMA_VIOLATION`,
 *   `TEXT_VALUES_FOR_INVALID`), and `x-telo-text-context` written anywhere but a
 *   data schema (`TEXT_CONTEXT_MISPLACED`, a warning).
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
import { effectiveAuthorSchema, hasOwnControllerOrTemplate } from "./extends-resolution.js";
import { selfForwardPath } from "./template-forward.js";
import { isKindDocument } from "./kind-declaration.js";
import type { ModuleDocuments } from "./module-documents.js";
import { declaringModuleKey, ROOT_MODULE_KEY, SELF_ALIAS } from "./module-call-names.js";
import { isModuleKind } from "./module-kinds.js";
import { moduleLangOf } from "./module-lang.js";
import {
  catalogComputedProblem,
  celTypeValueKind,
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
import { builtinErrorCodes, readText } from "@telorun/sdk";
import { judgeDataValues, judgeDeclaredValues } from "./text-values.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

type DefResolver = {
  (kind: string, from?: { metadata?: { module?: string } }): ResourceDefinition | undefined;
  in(kind: string, module?: string): ResourceDefinition | undefined;
};

export interface TextPassOptions {
  /** The flattened analysis set, forward views included. */
  readonly manifests: readonly ResourceManifest[];
  readonly rootModules: ReadonlySet<string>;
  readonly resolveDef: DefResolver;
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

function problemDiagnostic(problem: TextProblem, manifest: ResourceManifest, base: ValuePath, what: string) {
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
  /** True for a template body entry or a `base:` mapping, where a bare
   *  `self.<path>` forwards the consumer's value. */
  readonly forwards?: boolean;
}

export function validateTexts(options: TextPassOptions): AnalysisDiagnostic[] {
  const { manifests, rootModules, resolveDef, moduleDocuments } = options;
  const scope = new TextLanguageScope(listRequests(manifests), rootModules, moduleDocuments);
  const resolveNamed = (ref: string) => {
    const schema = options.schemaForId(ref);
    return schema ? { schema, root: schema } : undefined;
  };
  const schemaOfKind = (kind: unknown, module: string): Record<string, any> | undefined => {
    if (typeof kind !== "string") return undefined;
    const definition = resolveDef.in(kind, module === ROOT_MODULE_KEY ? undefined : module);
    if (!definition) return undefined;
    const schema = effectiveAuthorSchema(definition, (k) => resolveDef.in(k, definition.metadata?.module));
    return schema && typeof schema === "object" ? schema : undefined;
  };
  const walkOptions = { isExpression, resolveRef: resolveNamed };
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
    const schema = effectiveAuthorSchema(definition, (k) => resolveDef.in(k, definition!.metadata?.module));
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
    return texts.length > 0 ? { manifest, base: [], module, walk: { texts, values: [], expressions: [] } } : undefined;
  };

  /** Every place a module writes text: its resources, its template bodies, its
   *  `base:` mappings. */
  const writingsOf = (manifest: ResourceManifest, module: string): TextWriting[] => {
    if (isModuleKind(manifest.kind as string) || manifest.kind === "Telo.Import") return [];
    const out: TextWriting[] = [
      { manifest, base: [], module, walk: walkOf(schemaOfKind(manifest.kind, module), manifest) },
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
          walk: walkOf(schemaOfKind(entry.kind, module), entry),
          forwards: true,
        });
      });
    }
    if (isPlainObject(definition.base) && typeof definition.extends === "string") {
      out.push({
        manifest,
        base: ["base"],
        module,
        walk: walkOf(schemaOfKind(definition.extends, module), definition.base),
        forwards: true,
      });
    }
    return out;
  };

  // The texts each module shows, keyed by module name.
  const shown = new Map<string, Set<string>>();
  const show = (module: string, key: string) => {
    let set = shown.get(module);
    if (!set) shown.set(module, (set = new Set()));
    set.add(key);
  };

  const diagnostics: AnalysisDiagnostic[] = [];
  const catalogs: { writing: TextWriting; base: ValuePath; entries: { index: number; key: string }[] }[] = [];

  const visit = (manifest: ResourceManifest, module: string, judged: boolean): void => {
    const lang = scope.langOfModule(module);
    // One value reached twice — typed by the kind and forwarded by its `base:` —
    // is judged once.
    const judgedPaths = new Set<string>();
    for (const writing of writingsOf(manifest, module)) {
      for (const site of writing.walk.texts) {
        const path = [...writing.base, ...site.path];
        const at = renderValuePath(path);
        if (judgedPaths.has(at)) continue;
        judgedPaths.add(at);
        if (site.fragment === "TextCatalog") {
          if (!judged) continue;
          const catalog = siteValueOf(site);
          // A bare `self.<path>` a template body or a `base:` mapping writes hands
          // on what the consumer wrote, judged where the consumer wrote it.
          if (writing.forwards && selfForwardPath(catalog)) continue;
          if (expressionsWithin(catalog, isExpression).length === 0 && !options.accepts(site.fragment, catalog)) {
            continue;
          }
          const result = judgeCatalog(catalog, isExpression);
          for (const problem of result.problems) {
            diagnostics.push(problemDiagnostic(problem, manifest, path, "the text catalog entry"));
          }
          catalogs.push({ writing, base: path, entries: result.entries });
          continue;
        }
        if (expressionsWithin(site.value, isExpression).length > 0) continue;
        if (!options.accepts(site.fragment, site.value)) continue;
        if (site.fragment === "Message") {
          if (!judged) continue;
          const read = judgeMessage(site.value);
          for (const problem of read.problems) {
            diagnostics.push(problemDiagnostic(problem, manifest, path, "the message"));
          }
          if (read.message && site.declaredValues) {
            for (const problem of judgeDeclaredValues(read.message, site.declaredValues)) {
              diagnostics.push(problemDiagnostic(problem, manifest, path, "the message"));
            }
          }
          if (read.message && site.valuesFrom) {
            for (const problem of judgeDataValues(read.message, site.valuesFrom.schema, [...writing.base, ...site.valuesFrom.path])) {
              diagnostics.push(problemDiagnostic(problem, manifest, path, "the message"));
            }
          }
          continue;
        }
        const text = judgeText(site.value, lang);
        if (text.text) show(module, keyOfText(text.text));
        if (!judged) continue;
        for (const problem of text.problems) diagnostics.push(problemDiagnostic(problem, manifest, path, "the text"));
        if (text.text && site.declaredValues) {
          for (const problem of judgeDeclaredValues(text.text.message, site.declaredValues)) {
            diagnostics.push(problemDiagnostic(problem, manifest, path, "the text"));
          }
        }
        if (text.text && site.valuesFrom) {
          for (const problem of judgeDataValues(text.text.message, site.valuesFrom.schema, [...writing.base, ...site.valuesFrom.path])) {
            diagnostics.push(problemDiagnostic(problem, manifest, path, "the text"));
          }
        }
      }
      if (judged) {
        // An expression at a slot taking a literal text or a record is admitted
        // by the record branch alone.
        for (const expression of writing.walk.expressions) {
          if (!isTextOrRecordUnion(expression.schema, expression.root, walkOptions.resolveRef)) continue;
          const at = [...writing.base, ...expression.path];
          if (writing.forwards && selfForwardPath(valueAt(manifest, at))) continue;
          const produced = options.producedSchemaAt?.(manifest, renderValuePath(at));
          if (produced && producesTextRecord(produced, produced, walkOptions.resolveRef)) continue;
          diagnostics.push(
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
        if (writing.forwards && selfForwardPath(valueAt(manifest, at))) continue;
        diagnostics.push(problemDiagnostic(catalogComputedProblem(), manifest, at, "the value"));
      }
      for (const pairing of writing.walk.values) {
        if (
          !isPlainObject(pairing.values) ||
          isExpression(pairing.values) ||
          expressionsWithin(pairing.text, isExpression).length > 0
        ) {
          continue;
        }
        const read = readText(pairing.text);
        if (!read.ok) continue;
        const path = [...writing.base, ...pairing.path];
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
          diagnostics.push(
            problemDiagnostic(problem, manifest, path, `the values for the text at '${renderValuePath([...writing.base, ...pairing.textPath])}'`),
          );
        }
      }
    }
  };

  /** The data schemas a manifest holds — their texts are the module's, and their
   *  annotations are judged where they are written. */
  const visitSchemas = (manifest: ResourceManifest, module: string, judged: boolean): void => {
    if (isModuleKind(manifest.kind as string)) {
      if (judged) misplaced(manifest, new Set());
      return;
    }
    const sites = schemaValueSites(schemaOfKind(manifest.kind, module), manifest, isExpression);
    const dataNodes = new Set<object>();
    for (const site of sites) {
      if (site.role === "data") {
        for (const text of schemaTexts(site.value)) show(module, text.key);
        for (const { node } of schemaNodes(site.value)) dataNodes.add(node);
      }
      if (!judged) continue;
      for (const problem of textAnnotationProblems(site)) {
        const path = [...site.path, ...problem.path];
        diagnostics.push(diagnostic(problem.code, `${problem.message}.`, { manifest, path }));
      }
    }
    if (judged) misplaced(manifest, dataNodes);
  };

  const misplaced = (manifest: ResourceManifest, dataNodes: ReadonlySet<object>): void => {
    for (const { node, path } of textContextNodes(manifest)) {
      if (dataNodes.has(node)) continue;
      diagnostics.push(
        diagnostic(
          "TEXT_CONTEXT_MISPLACED",
          `${TEXT_CONTEXT_ANNOTATION} is read only on a data schema — a named shape, a status block, a contract, a callable's parameters and result, or a schema written at a 'use: schema' slot — where it gives the context of the node's title, description and enum labels. Here nothing reads it.`,
          { manifest, path: [...path, TEXT_CONTEXT_ANNOTATION] },
          DiagnosticSeverity.Warning,
        ),
      );
    }
  };

  // The entry's own manifests and the forward views (declared in the consumer's
  // module), judged and enumerated; a library's, enumerated from its full
  // documents where the analysis holds them, else from what the flattened set
  // forwards of it.
  const documented = new Set(moduleDocuments.map((doc) => doc.module));
  const ownCallers: { manifest: ResourceManifest; module: string }[] = [];
  for (const manifest of manifests) {
    const owned = scope.isOwned(manifest);
    const module = scope.moduleOf(manifest);
    if (!owned && documented.has(module)) continue;
    visit(manifest, module, owned);
    visitSchemas(manifest, module, owned);
    ownCallers.push({ manifest, module });
  }
  for (const library of moduleDocuments) {
    for (const manifest of library.manifests) {
      visit(manifest, library.module, false);
      visitSchemas(manifest, library.module, false);
      ownCallers.push({ manifest, module: library.module });
    }
  }

  // Literal text arguments at `Text` parameters, read off each module's own CEL.
  const resolver = new CalleeResolver(manifests, moduleDocuments, scope, resolveDef);
  for (const { manifest, module } of ownCallers) {
    const names = options.moduleCallNames.get(module) ?? options.moduleCallNames.get(ROOT_MODULE_KEY);
    if (!names) continue;
    for (const source of celSourcesOf(manifest)) {
      const parsed = parseCelSource(source, names);
      if (!parsed) continue;
      for (const call of writtenCalls(parsed.root)) {
        const params = resolver.paramsOf(call.qualified, module);
        for (const parameter of textParameters(params)) {
          const argument = call.arguments[parameter.index];
          if (!argument?.literal) continue;
          const read = readText(argument.value);
          if (read.ok) show(module, keyOfText(read.text));
        }
      }
    }
  }

  // MESSAGE_TEXT_UNUSED: a catalog key no module of its closure shows.
  const closure = new ClosureTexts(manifests, scope, shown);
  for (const { writing, base, entries } of catalogs) {
    const texts = closure.of(writing.module);
    for (const entry of entries) {
      if (texts.has(entry.key)) continue;
      const path = [...base, "texts", entry.index, "text"];
      diagnostics.push(
        diagnostic(
          "MESSAGE_TEXT_UNUSED",
          `the text at '${renderValuePath(path)}' is shown by no module this catalog's module imports, directly or through others, so its translation is never used. Correct the text and context to match the source exactly, or import the module whose texts this catalog translates.`,
          { manifest: writing.manifest, path },
          DiagnosticSeverity.Warning,
        ),
      );
    }
  }
  return diagnostics;
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
class CalleeResolver {
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
function builtinShownTexts(): ReadonlySet<string> {
  builtinShown ??= new Set(
    builtinErrorCodes().flatMap((entry) => {
      const read = readText(entry.displayMessage);
      return read.ok ? [keyOfText(read.text)] : [];
    }),
  );
  return builtinShown;
}

/** The texts a module's whole import closure shows, memoized per module. */
class ClosureTexts {
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
    const seen = new Set<string>();
    const pending = [module];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const key of this.shown.get(next) ?? []) texts.add(key);
      for (const target of this.edges.get(next) ?? []) pending.push(target);
    }
    this.memo.set(module, texts);
    return texts;
  }
}
