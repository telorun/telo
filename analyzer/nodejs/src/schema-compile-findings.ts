/**
 * The schema compile failures of the kind documents, over every
 * configuration at once.
 *
 * A kind's schema is compiled once with every named shape it references read
 * as its stand-in (`NamedShapeReader.standIns`), so its own content decides
 * its own verdict. Each class of each shape it reaches is compiled once on its
 * own, its own named references stood in the same way; a failing reference
 * pair — the document writing the reference and the shape it names — is one
 * `SCHEMA_COMPILE_ERROR` at the kind, held where the pair is reached and the
 * shape there does not compile or holds no node at the pointer. The plain
 * analysis runs the same rule over its one configuration. A pattern RE2 refuses
 * is never one of these: the schema fragments report it as `SCHEMA_VIOLATION`
 * where the schema is written.
 *
 * A shape of a library imported more than once is read as the classes of
 * every instance (`NamedShapeReader.classes`), never one instance's: a kind
 * document is one document for every instance of its module, so what it finds
 * through a shape holds where some instance reads that class.
 *
 * Browser-safe.
 */
import { schemaPatternRefusalIn } from "./schema-validation.js";
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { declaringModuleScope } from "./module-alias-scope.js";
import { nodeAtPointer, type NamedShapeReader, type ShapeEdge } from "./named-shape-reader.js";
import { FALSE, TRUE } from "./presence-condition.js";
import { canonicalShapeSchema } from "./resolve-schema-type-refs.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import type { ReadFinding } from "./union-passes.js";

const SOURCE = "telo-analyzer";

export interface SchemaCompileScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: Set<string>;
}

/** A kind document's schema, canonical in its declaring module: each
 *  `telo://<authority>/<Type>` made `telo:<module>/<Type>`; a tag stays the
 *  text it compiles as. */
export function canonicalKindSchema(m: ResourceManifest, scope: SchemaCompileScope): Record<string, any> | undefined {
  const schema = (m as Record<string, any>).schema;
  if (!schema || typeof schema !== "object") return undefined;
  // The copy the registry froze for the kind, when `m` is the document it was registered from.
  const registered = scope.defs.registeredSchemaOf(m);
  if (registered) return registered;
  const module = (m.metadata as { module?: string } | undefined)?.module;
  if (!module) return schema as Record<string, any>;
  const moduleScope = declaringModuleScope(module, scope.aliases, scope);
  return canonicalShapeSchema(schema as Record<string, any>, module, (alias) => moduleScope.moduleForAlias(alias));
}

/** The kind documents' schemas, canonical in their declaring modules. */
function kindSchemas(kinds: readonly ResourceManifest[], scope: SchemaCompileScope) {
  const out: { m: ResourceManifest; name: string; schema: Record<string, any> }[] = [];
  for (const m of kinds) {
    if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    const schema = canonicalKindSchema(m, scope);
    if (schema) out.push({ m, name, schema });
  }
  return out;
}

/** Whether `error` is the schema pattern seam's refusal of a pattern `schema`
 *  holds — a `SCHEMA_VIOLATION` at the pattern, which the schema fragments report
 *  where the schema is written, never a compile error. */
function isPatternRefusal(schema: unknown, error: string): boolean {
  return schemaPatternRefusalIn(schema)?.message === error;
}

/** What AJV reports for a reference that names nothing. */
function missingReference(ref: string, from: string): string {
  return `can't resolve reference ${ref} from id ${from}`;
}

export function schemaCompileFindings(
  kinds: readonly ResourceManifest[],
  shapes: NamedShapeReader,
  scope: SchemaCompileScope,
): ReadFinding[] {
  const { space } = shapes;
  const written = kindSchemas(kinds, scope);
  const roots = written.map((each) => shapes.edges(each.schema));
  return scope.defs.withStandInCompiler(shapes.standIns(roots), (compile) => {
    const classError = (id: string, index: number): string | undefined => {
      const shape = shapes.classes(id)[index]!;
      const error = shapes.verdict("compile", shape, () => compile(shape.schema, id));
      return error !== undefined && isPatternRefusal(shape.schema, error) ? undefined : error;
    };
    /** Where `edge`'s target compiles and holds a node at its pointer. */
    const compilesAt = (edge: ShapeEdge) => {
      let held = FALSE;
      for (const shape of shapes.classes(edge.target)) {
        if (classError(edge.target, shape.index) !== undefined) continue;
        const node = nodeAtPointer(shape.schema, edge.pointer);
        if (!node || typeof node !== "object") continue;
        held = space.or(held, shape.condition);
      }
      return held;
    };
    const out: ReadFinding[] = [];
    written.forEach(({ m, name, schema }, at) => {
      const diagnostic = (text: string): AnalysisDiagnostic => ({
        severity: DiagnosticSeverity.Error,
        code: "SCHEMA_COMPILE_ERROR",
        source: SOURCE,
        message: `${m.kind}/${name}: definition schema failed to compile: ${text}`,
        data: {
          resource: { kind: m.kind, name },
          filePath: (m.metadata as { source?: string } | undefined)?.source,
          path: "schema",
        },
      });
      const own = compile(schema);
      if (own !== undefined && !isPatternRefusal(schema, own)) {
        out.push({ held: TRUE, render: () => [diagnostic(own)] });
      }
      for (const pair of shapes.reach(roots[at]!)) {
        const held = space.and(pair.condition, space.not(compilesAt(pair)));
        if (held === FALSE) continue;
        const from = pair.writer ?? (typeof schema.$id === "string" ? schema.$id : "#");
        out.push({
          held,
          render: (read) => {
            const shape = shapes.classAt(pair.target, read);
            const error = shape ? classError(pair.target, shape.index) : undefined;
            return [diagnostic(error ?? missingReference(pair.ref, from))];
          },
        });
      }
    });
    return out;
  });
}
