/**
 * What a kind document's schema annotations refuse: a text slot at or beneath
 * an accessor field, a malformed text-values, text-keys, browser-export,
 * application-source or path-params annotation, a malformed co-referrer call,
 * a misdirected `outputTo` or `completedWhen`, a union giving one property two
 * eval modes (`eval-mode-branch-findings.ts`), and a value-schema-from location
 * a named shape its contract names carries for it. Its scope is the kind
 * documents and the named-shape declarations their schemas are built from: a
 * kind document never varies, so each of its own is judged once; a named
 * shape's own `completedWhen` is judged per declaration, as its own choices
 * decide it, reached or not.
 *
 * The three walks that follow references into named shapes read each shape
 * through the named-shape reader (`kind-shape-walk.ts`): the kind's own
 * content once, each class of each shape it reaches once per pointer, and
 * what a walk finds inside a shape held where its class is reached. A shape
 * the walk names directly — the node a reference names, the fields of an
 * object it names — is read per class. An `outputTo` follows its sibling
 * pointer and its member through the shapes on the way (`pathEnds`), and a
 * shape a contract names carries its value-schema-from annotations per class.
 *
 * Browser-safe.
 */
import { parseCanonicalTypeSchemaId, type ResourceDefinition, type ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { applicationSourceAnnotationProblems } from "./application-source-slot.js";
import { browserExportAnnotationProblems } from "./browser-export-slot.js";
import { coReferrerCallProblems } from "./co-referrer-slot.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { kindDocumentProblemDiagnostic, quotingWrittenPlace, type KindDocumentProblem } from "./kind-document-problem.js";
import {
  classWalkParts,
  entriesThroughShapes,
  pathEnds,
  shapeEdgeOf,
  walkParts,
  walkReach,
  type ShapeAccess,
  type ShapeRoot,
  type ShapeWalkVerdict,
} from "./kind-shape-walk.js";
import type { NamedShapeReader, ShapeEdge } from "./named-shape-reader.js";
import { isEntryOwned } from "./entry-ownership.js";
import { contractDeclarer, effectiveContractField, inheritedCapability, type DefResolver } from "./extends-resolution.js";
import { contractRoot } from "./kind-contract-findings.js";
import { registeredDefinitionCopy } from "./resolve-schema-type-refs.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { outputToProblems } from "./output-to-slot.js";
import { schemaReferenceParts } from "./schema-reference.js";
import { DiagnosticSeverity } from "./types.js";
import { withQuotedPath } from "./quoted-place.js";
import { namedContractShape, shapeValueSchemaFromProblems, slotKindResolverOf } from "./validate-value-schema-location.js";
import { valueSchemaAnnotations } from "./value-schema-slot.js";
import {
  pathParamsAnnotationProblemOf,
  walkPathParamsAnnotations,
  type PathParamsAnnotationEntry,
} from "./path-params-slot.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import type { ImportReach } from "./reaching-import.js";
import { COMPLETED_WHEN_CODE, heldCompletedWhenProblems } from "./completed-when-slot.js";
import { declaringModuleScope } from "./module-alias-scope.js";
import type { ModuleDocuments } from "./module-documents.js";
import { canonicalShapeSchema, withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";
import { splitByReads } from "./world-reader.js";
import { evalModeBranchFindings } from "./eval-mode-branch-findings.js";
import { kindDeclarationOf } from "./kind-declaration.js";
import { canonicalKindSchema } from "./schema-compile-findings.js";
import { textKeysProblems } from "./text-keys.js";
import {
  textBeneathNode,
  textSlotAccessorProblemOf,
  walkTextSlotAccessors,
  type TextSlotAccessorEntry,
} from "./text-slot-accessor.js";
import { pointerSegments, type TextFragment, type ValuePath } from "./text-slot.js";
import { holdersAlong, textValuesProblemOf, walkTextValues, type TextValuesEntry } from "./text-values.js";
import type { AnalysisDiagnostic } from "./types.js";
import type { ReadFinding } from "./union-passes.js";

type Schema = Record<string, any>;

const SOURCE = "telo-analyzer";

export interface KindAnnotationScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  readonly reach: ImportReach;
  /** The named shapes, as the analysis reads them. */
  readonly shapes: NamedShapeReader;
  /** Each imported library's own documents, judged as written. */
  readonly moduleDocuments: readonly ModuleDocuments[];
  /** A document as written, where the documents judged are the analysis's own
   *  copies; the document itself otherwise. */
  readonly writtenOf?: (manifest: ResourceManifest) => ResourceManifest | undefined;
}

const typeName = (id: string) => parseCanonicalTypeSchemaId(id)?.typeName ?? id;

/** The pointer `ref` names, as the segments a place inside the shape starts at. */
const innerOf = (pointer: string): ValuePath => pointerSegments(pointer.slice(1)) ?? [];

/** One finding a walk makes at the kind: its problem, rendered at the kind's
 *  path, where it holds. */
interface KindFinding {
  readonly held: Condition;
  render(read: Parameters<ReadFinding["render"]>[0]): Omit<KindDocumentProblem, "code"> | undefined;
}

/** A walk's findings: the kind's own, and those of the shapes it reaches. */
function walkFindings<E>(
  shapes: NamedShapeReader,
  verdict: ShapeWalkVerdict<E>,
  own: (access: ShapeAccess, met: (ref: string, path: ValuePath) => void) => readonly E[],
  finding: (entry: E, path: ValuePath | undefined, held: Condition) => KindFinding | undefined,
): KindFinding[] {
  const out: KindFinding[] = [];
  for (const part of walkParts(shapes, verdict.kindSchemaOf, (access) => {
    const roots: ShapeRoot<ValuePath>[] = [];
    const entries = own(access, (ref, path) => roots.push({ where: path, edge: shapeEdgeOf(ref) }));
    return { entries, roots };
  })) {
    for (const entry of part.walk.entries) {
      const found = finding(entry, undefined, part.condition);
      if (found) out.push(found);
    }
    for (const held of entriesThroughShapes(shapes, verdict, part.walk.roots, part.condition)) {
      const found = finding(held.entry, held.where, held.held);
      if (found) out.push(found);
    }
  }
  return out;
}

/** Every kind document's annotation problems, once per kind. */
export function kindAnnotationFindings(kinds: readonly ResourceManifest[], scope: KindAnnotationScope): ReadFinding[] {
  const { defs, reach, shapes } = scope;
  const { space } = shapes;
  const kindSchemaOf = (id: string) => defs.schemaForId(id);
  const resolveDef: DefResolver = (kind, from) => {
    const moduleScope = moduleAliasScope(from?.metadata, scope.aliases, scope.aliasesByModule);
    return defs.resolve(kind) ?? defs.resolve(moduleScope.resolveKind(kind) ?? kind);
  };
  const compileScope = {
    defs,
    aliases: scope.aliases,
    aliasesByModule: scope.aliasesByModule,
    rootModules: new Set(scope.rootModules),
  };

  /** What text an accessor's value reaches beneath the named shapes `refs`
   *  name, each where it is reached, in written order. */
  const textVerdict: ShapeWalkVerdict<TextFragment> = {
    name: "textBeneath",
    kindSchemaOf,
    walk: (shape, node, pointer, access) => {
      const beneath = textBeneathNode(node, shape.schema, access.lookup, access.stops);
      return { entries: beneath.found ? [beneath.found.fragment] : [], edges: beneath.met.map(shapeEdgeOf) };
    },
    identity: (fragment) => fragment,
  };
  const textOptions = (refs: readonly string[], within: string | undefined, at: Condition) => {
    const options: { fragment: TextFragment; shape: string; held: Condition }[] = [];
    for (const ref of refs) {
      const edge = shapeEdgeOf(ref);
      const byFragment = new Map<TextFragment, Condition>();
      for (const pair of walkReach(shapes, textVerdict, [edge], at)) {
        for (const shape of shapes.classes(pair.target)) {
          const base = space.and(pair.condition, shape.condition);
          if (base === FALSE) continue;
          for (const part of classWalkParts(shapes, textVerdict, shape, pair.pointer)) {
            for (const fragment of part.walk.entries) {
              byFragment.set(fragment, space.or(byFragment.get(fragment) ?? FALSE, space.and(base, part.condition)));
            }
          }
        }
      }
      for (const [fragment, held] of byFragment) if (held !== FALSE) options.push({ fragment, shape: within ?? typeName(edge.target), held });
    }
    return options;
  };

  const accessorVerdict: ShapeWalkVerdict<TextSlotAccessorEntry> = {
    name: "textSlotAccessor",
    kindSchemaOf,
    walk: (shape, node, pointer, access) => {
      const edges: ShapeEdge[] = [];
      const entries = walkTextSlotAccessors(
        { node, path: [], shape: { name: typeName(shape.id), document: shape.schema, inner: innerOf(pointer) } },
        access.lookup,
        { stops: access.stops, met: (ref) => edges.push(shapeEdgeOf(ref)) },
      );
      return { entries, edges };
    },
    identity: (entry) => JSON.stringify({ ...entry, path: undefined }),
  };
  const valuesVerdict: ShapeWalkVerdict<TextValuesEntry> = {
    name: "textValues",
    kindSchemaOf,
    walk: (shape, node, pointer, access) => {
      const edges: ShapeEdge[] = [];
      const entries = walkTextValues(
        { node, root: shape.schema, path: [], shape: typeName(shape.id), inner: [], holders: holdersAlong(`${shape.id}${pointer}`) },
        access.lookup,
        { stops: access.stops, met: (ref) => edges.push(shapeEdgeOf(ref)) },
      );
      return { entries, edges };
    },
    identity: (entry) => JSON.stringify({ ...entry, path: undefined }),
  };
  const pathParamsVerdict: ShapeWalkVerdict<PathParamsAnnotationEntry> = {
    name: "pathParamsAnnotations",
    kindSchemaOf,
    walk: (shape, node, pointer, access) => {
      const edges: ShapeEdge[] = [];
      const entries = walkPathParamsAnnotations(
        { node, root: shape.schema, path: [], shape: typeName(shape.id), inner: [], skipStart: true },
        access.lookup,
        { stops: access.stops, met: (ref) => edges.push(shapeEdgeOf(ref)) },
      );
      return { entries, edges };
    },
    identity: (entry) => JSON.stringify({ ...entry, path: undefined }),
  };

  const out: ReadFinding[] = [];
  /** A document's misdirected `completedWhen`s, its schema `schema` read once
   *  within `at`, each held where the shapes on its sibling path hold. */
  const completedWhen = (m: ResourceManifest, module: string | undefined, schema: Schema | undefined, at: Condition): void => {
    const byText = new Map<string, { problem: KindDocumentProblem; slotPath: string; held: Condition }>();
    const reads = {
      everywhere: at,
      follow: (node: Schema, document: Schema, segments: readonly string[], within: Condition) =>
        pathEnds(shapes, kindSchemaOf, node, document, segments, within),
    };
    for (const { held, slotPath, ...problem } of heldCompletedWhenProblems(schema, `'${String(m.metadata?.name)}'`, "schema", reads)) {
      const key = JSON.stringify([problem.path, problem.message]);
      const known = byText.get(key);
      if (known) known.held = space.or(known.held, held);
      else byText.set(key, { problem, slotPath, held });
    }
    for (const { problem, slotPath, held } of byText.values()) {
      if (held !== FALSE) out.push({ held, render: () => [quotingWrittenPlace(kindDocumentProblemDiagnostic(m, module, problem, reach), problem.path, slotPath)] });
    }
  };
  /** `schema` canonical in `module`, as the registry holds a shape's. */
  const canonicalIn = (schema: unknown, module: string): Schema | undefined => {
    if (!schema || typeof schema !== "object") return undefined;
    const moduleScope = declaringModuleScope(module, scope.aliases, compileScope);
    const moduleForAlias = (alias: string) => moduleScope.moduleForAlias(alias);
    return canonicalShapeSchema(withCanonicalRefSentinels(schema, module, moduleForAlias) as Schema, module, moduleForAlias);
  };

  const judged = new Set<string>();
  for (const m of kinds) {
    if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
    const ownModule = (m.metadata as { module?: string } | undefined)?.module;
    const key = `${ownModule ?? ""}\0${String(m.metadata?.name)}`;
    if (judged.has(key)) continue;
    judged.add(key);
    const name = String(m.metadata?.name);
    const diagnostic = (code: string, problem: Omit<KindDocumentProblem, "code">): AnalysisDiagnostic =>
      kindDocumentProblemDiagnostic(m, ownModule, { ...problem, code }, reach);
    const always = (code: string, problems: readonly Omit<KindDocumentProblem, "code">[]) => {
      for (const problem of problems) out.push({ held: TRUE, render: () => [diagnostic(code, problem)] });
    };
    const held = (code: string, findings: readonly KindFinding[]) => {
      for (const finding of findings) {
        out.push({
          held: finding.held,
          render: (read) => {
            const problem = finding.render(read);
            return problem ? [diagnostic(code, problem)] : [];
          },
        });
      }
    };
    const schema = canonicalKindSchema(m, compileScope);
    const at: ValuePath = ["schema"];

    held(
      "TEXT_SLOT_ACCESSOR",
      walkFindings(
        shapes,
        accessorVerdict,
        (access, met) =>
          schema && typeof schema.properties === "object" ? walkTextSlotAccessors({ schema, at }, access.lookup, { stops: access.stops, met }) : [],
        (entry, path, within) => {
          if (entry.found) return { held: within, render: () => textSlotAccessorProblemOf(name, entry, entry.found!, path ?? entry.path) };
          const options = textOptions(entry.beneath ?? [], entry.shape?.name, within);
          const reached = space.some(options.map((option) => option.held));
          if (reached === FALSE) return undefined;
          return {
            held: reached,
            render: (read) => {
              const option = options.find((each) => read.holds(each.held));
              return option && textSlotAccessorProblemOf(name, entry, { fragment: option.fragment, shape: option.shape }, path ?? entry.path);
            },
          };
        },
      ),
    );
    held(
      "TEXT_VALUES_INVALID",
      walkFindings(
        shapes,
        valuesVerdict,
        (access, met) =>
          schema ? walkTextValues({ node: schema, root: schema, path: at, inner: [], holders: 0 }, access.lookup, { stops: access.stops, met }) : [],
        (entry, path, within) => ({ held: within, render: () => textValuesProblemOf(name, entry, path ?? entry.path) }),
      ),
    );
    // The kinds an annotation names are compared canonical, as the registry's
    // copy holds them; an unresolved name is quoted as written.
    const registered = defs.withCanonicalKinds(m) as unknown as ResourceDefinition;
    always("TEXT_KEYS_INVALID", textKeysProblems(name, registered.schema, (kind) => defs.resolve(kind)));
    always("BROWSER_EXPORT_ANNOTATION_INVALID", browserExportAnnotationProblems(name, m.schema));
    always("APPLICATION_SOURCE_ANNOTATION_INVALID", applicationSourceAnnotationProblems(name, m.schema));
    held(
      "PATH_PARAMS_FOR_INVALID",
      walkFindings(
        shapes,
        pathParamsVerdict,
        (access, met) =>
          schema ? walkPathParamsAnnotations({ node: schema, root: schema, path: at, inner: [] }, access.lookup, { stops: access.stops, met }) : [],
        (entry, path, within) => ({ held: within, render: () => pathParamsAnnotationProblemOf(name, entry, path ?? entry.path) }),
      ),
    );
    for (const problem of coReferrerCallProblems(registered, registered.schema, (kind) => defs.resolve(kind), true).problems) {
      always(problem.code, [problem]);
    }
    completedWhen(m, ownModule, schema, TRUE);
    if (!isEntryOwned(m, scope.rootModules)) continue;
    const entryOwned = (code: string, path: string, message: string): AnalysisDiagnostic => ({
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message,
      data: { resource: { kind: m.kind, name }, filePath: (m.metadata as { source?: string } | undefined)?.source, path },
    });
    // One finding per text, where any part reaching it holds.
    const merged = (
      findings: readonly { readonly path: string; readonly message: string; readonly held: Condition; readonly quotes?: string }[],
      code: string,
    ) => {
      const byText = new Map<string, { path: string; message: string; held: Condition; quotes?: string }>();
      for (const found of findings) {
        const key = JSON.stringify([found.path, found.message]);
        const known = byText.get(key);
        if (known) known.held = space.or(known.held, found.held);
        else byText.set(key, { ...found });
      }
      for (const found of byText.values()) {
        if (found.held === FALSE) continue;
        const diagnostic = entryOwned(code, found.path, found.message);
        out.push({ held: found.held, render: () => [found.quotes === undefined ? diagnostic : withQuotedPath(diagnostic, found.quotes)] });
      }
    };

    merged(
      outputToProblems(registered, schema, resolveDef, {
        everywhere: shapes.source.universe,
        follow: (node, document, segments, within) => pathEnds(shapes, kindSchemaOf, node, document, segments, within),
        inputContract: (target) => {
          const declared = effectiveContractField(target, resolveDef, "inputType");
          if (declared === undefined || declared === null) return undefined;
          const declarer = contractDeclarer(target, resolveDef, "inputType");
          const module = (declarer?.metadata as { module?: string } | undefined)?.module;
          return contractRoot(declared, undefined, module, moduleAliasScope(declarer?.metadata, scope.aliases, scope.aliasesByModule), shapes)?.node;
        },
      }).map((problem) => ({ ...problem, quotes: problem.slotPath })),
      "X_TELO_REF_INVALID_OUTPUT_TO",
    );

    // The value-schema-from annotations a named shape the kind's contract names
    // carries for it: read once per class of the shape, judged against the
    // kind's effective schema, each where its class holds.
    const own = (defs.resolve(ownModule ? `${ownModule}.${name}` : name) ??
      registeredDefinitionCopy(m, scope.aliases, scope.aliasesByModule)) as unknown as ResourceDefinition;
    const effective = defs.effectiveSchemaOf(own) as Schema | undefined;
    const shapeProblems: { path: string; message: string; held: Condition }[] = [];
    const slotKinds = slotKindResolverOf(
      (kind, from) => resolveDef(kind, from as ResourceDefinition | undefined) as Record<string, any> | undefined,
      (definition) => defs.effectiveSchemaOf(definition as ResourceDefinition) as Record<string, any> | undefined,
    );
    for (const field of ["inputType", "outputType"] as const) {
      const value = (own as unknown as Record<string, unknown>)[field];
      if (!namedContractShape(value)) continue;
      const root = contractRoot(value, undefined, ownModule, moduleAliasScope(m.metadata, scope.aliases, scope.aliasesByModule), shapes)?.node;
      if (!root || typeof root.$ref !== "string") continue;
      const { shape: id, pointer } = schemaReferenceParts(root.$ref);
      if (id === undefined || pointer !== "#" || !shapes.isShapeId(id)) continue;
      for (const shape of shapes.classes(id)) {
        const annotations = shapes.verdict("valueSchemaAnnotations", shape, () => valueSchemaAnnotations(shape.schema));
        for (const problem of shapeValueSchemaFromProblems(name, field, { name: typeName(id), schema: shape.schema }, effective, annotations, slotKinds)) {
          shapeProblems.push({ path: problem.path, message: `${m.kind} ${problem.message}`, held: shape.condition });
        }
      }
    }
    merged(shapeProblems, "VALUE_SCHEMA_FROM_INVALID");
  }

  // A union giving one property two eval meanings, at the document declaring
  // it, held where a kind's schema reaches it.
  out.push(
    ...evalModeBranchFindings(
      kinds.flatMap((m) => {
        const declared = kindDeclarationOf(m);
        if (!declared) return [];
        const module = (m.metadata as { module?: string } | undefined)?.module;
        const schema = declared.schema as Schema | undefined;
        return [{ manifest: m, module, schema: module ? canonicalIn(schema, module) : schema }];
      }),
      { shapes, kindSchemaOf, rootModules: scope.rootModules, reach, moduleDocuments: scope.moduleDocuments, writtenOf: scope.writtenOf },
    ),
  );

  // Every declaration of an entry module's named shape, reached or not, each
  // as its own choices decide it: the kernel refuses the shape as it registers
  // it. An `extends` parent's annotation is the parent's own declaration's.
  for (const id of shapes.declaredIds()) {
    for (const declaration of shapes.declarationsOf(id)) {
      const module = (declaration.manifest.metadata as { module?: string } | undefined)?.module;
      if (!module || !scope.rootModules.has(module)) continue;
      const start = space.and(shapes.source.universe, declaration.condition);
      if (start === FALSE) continue;
      for (const part of splitByReads(space, start, (read) => declaration.project(read))) {
        if (part.value) completedWhen(part.value, module, canonicalIn(part.value.schema, module), part.condition);
      }
    }
  }
  // An imported library's kinds and named shapes, as written, once, at the
  // `imports:` entry reaching it.
  for (const library of scope.moduleDocuments) {
    if (scope.rootModules.has(library.module)) continue;
    const libraryScope = declaringModuleScope(library.module, scope.aliases, compileScope);
    for (const m of library.manifests) {
      const name = m.metadata?.name;
      if (typeof name !== "string" || typeof m.kind !== "string") continue;
      const key = `${library.module}\0${name}`;
      if (judged.has(key)) continue;
      const kindDocument = m.kind === "Telo.Definition" || m.kind === "Telo.Abstract";
      if (!kindDocument && inheritedCapability(defs.resolve(libraryScope.resolveKind(m.kind) ?? m.kind), (k) => defs.resolve(k)) !== "Telo.Type") continue;
      judged.add(key);
      completedWhen(m, library.module, canonicalIn(m.schema, library.module), TRUE);
    }
  }
  return out;
}
