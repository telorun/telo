import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { walkCelExpressions } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { definitionInScope } from "./module-alias-scope.js";
import { isRefEntry, resolveFieldEntries } from "./reference-field-map.js";
import {
  declaredScopes,
  isScopeMember,
  outsideScopesOf,
  scopeEncloses,
  type DeclaredScope,
  type OutsideScope,
} from "./scope-declarations.js";
import { forEachStep, stepBodiesOf } from "./step-bodies.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

const DECLARATION_KINDS = new Set([
  "Telo.Definition",
  "Telo.Abstract",
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
]);

/**
 * `SCOPED_NAME_OUT_OF_REACH` — a declaration written inside a scope's region but
 * created outside the scope (see {@link OutsideScope}) naming one of the scope's
 * resources.
 *
 * Written there, the name reads as reachable — the scope's names shadow the
 * module's in its regions — while at run time it resolves to nothing, or to a
 * module-level resource that merely shares it. Reported at the reference, in
 * each spelling a name can be read in:
 *
 *  - a `!ref` sentinel, anywhere — the tag is unambiguous;
 *  - a resolved `{kind, name}`, but ONLY where the declaring kind says a
 *    reference is: a reference slot of its field map, or a step's dispatch slot.
 *    An object that merely has those keys is data;
 *  - `resources.<name>` in a CEL expression.
 *
 * Lexical: a scope declared on the way from the out-of-reach declaration down to
 * the reference — found through the kinds' own scope slots — shadows the name
 * again, since that one IS created around it. Entry-module-scoped: a
 * dependency's code is its own analysis's to report.
 *
 * Browser-safe.
 */
export function validateScopedNameReach(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
  /** Member-access chains of a CEL expression — the analyzer's own parse.
   *  Takes the declaring manifest because the chains depend on it: a call whose
   *  receiver is one of that module's names is a module call, and its receiver
   *  is not a chain at all. */
  accessChains: (expression: string, declaringManifest: ResourceManifest) => string[][],
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];

  for (const root of manifests) {
    if (!root.kind || DECLARATION_KINDS.has(root.kind) || isForwardedDeclaration(root)) continue;
    const meta = root.metadata as { name?: unknown; module?: unknown; source?: unknown } | undefined;
    if (typeof meta?.name !== "string") continue;
    const module = typeof meta.module === "string" ? meta.module : undefined;
    if (module && !rootModules.has(module)) continue;

    const resource = { kind: root.kind, name: meta.name };
    const filePath = typeof meta.source === "string" ? meta.source : undefined;
    const report = (path: string, name: string, scope: OutsideScope) =>
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "SCOPED_NAME_OUT_OF_REACH",
        source: SOURCE,
        message:
          `${scope.ownerKind}/${scope.ownerName}: '${name}' is declared in '${scope.field}:', but ` +
          `the inline declaration referencing it is created where '${scope.ownerName}' is ` +
          `declared, outside that scope, so the reference cannot reach it. Declare the ` +
          `referencing resource under '${scope.field}:' with a name of its own and point at it ` +
          `with '!ref'.`,
        data: { resource, filePath, path },
      });

    /** A declaration's kind, field map and scopes, read in its module's aliases. */
    const shape = (declaration: ResourceManifest) => {
      const view =
        module !== undefined && typeof declaration.metadata?.module !== "string"
          ? ({ ...declaration, metadata: { ...declaration.metadata, module } } as ResourceManifest)
          : declaration;
      const fieldMap = registry.expandedFieldMapForResource(view, aliases, aliasesByModule);
      const definition = definitionInScope<ResourceDefinition>(
        registry,
        view.kind,
        view.metadata,
        aliases,
        aliasesByModule,
      );
      return {
        fieldMap,
        scopes: declaredScopes(declaration as Record<string, unknown>, fieldMap),
        schema: registry.effectiveSchemaOf(definition) as Record<string, any> | undefined,
      };
    };

    const check = (
      declaration: ResourceManifest,
      prefix: string,
      reach: ReadonlyMap<string, OutsideScope>,
      shadowed: ReadonlySet<string>,
    ): void => {
      const stamped = outsideScopesOf(declaration);
      const nextReach = new Map(reach);
      const nextShadowed = new Set(shadowed);
      for (const scope of stamped) {
        for (const name of scope.names) {
          nextReach.set(name, scope);
          nextShadowed.delete(name);
        }
      }
      const { fieldMap, scopes, schema } = shape(declaration);
      for (const scope of scopes) {
        for (const member of scope.declarations) {
          if (isScopeMember(member)) nextShadowed.add(member.metadata.name);
        }
      }

      const at = (path: string) => (prefix ? (path ? `${prefix}.${path}` : prefix) : path);
      const test = (name: string | undefined, path: string) => {
        if (name === undefined || nextShadowed.has(name)) return;
        const scope = nextReach.get(name);
        if (scope) report(at(path), name, scope);
      };
      const inScopeArray = (path: string) =>
        scopes.some((scope: DeclaredScope) => scopeEncloses({ ...scope, regions: [scope.path] }, path));

      // Tagged `!ref`s and CEL, anywhere but the declaration's own metadata and
      // scope arrays (their members are checked below, with their own shadowing).
      walkCelExpressions(declaration, "", (source, path, engine) => {
        if (path === "metadata" || path.startsWith("metadata.") || inScopeArray(path)) return;
        if (engine === "ref") {
          test(localName(source), path);
        } else if (engine === "cel") {
          for (const chain of accessChains(source, root)) {
            if (chain[0] === "resources" && chain.length > 1) test(chain[1], path);
          }
        }
      });

      // A resolved reference, where the kind declares one.
      if (fieldMap) {
        for (const [fieldPath, entry] of fieldMap) {
          if (!isRefEntry(entry)) continue;
          for (const { value, path } of resolveFieldEntries(declaration, fieldPath)) {
            if (inScopeArray(path)) continue;
            test(resolvedLocalName(value), path);
          }
        }
      }
      if (schema) {
        for (const body of stepBodiesOf(declaration as Record<string, unknown>, schema)) {
          forEachStep(body, schema, (step, stepPath) =>
            test(resolvedLocalName(step[body.invokeField]), `${stepPath}.${body.invokeField}`),
          );
        }
      }

      for (const scope of scopes) {
        scope.declarations.forEach((member, i) => {
          if (isScopeMember(member)) {
            check(member, at(`${scope.path}[${i}]`), nextReach, nextShadowed);
          }
        });
      }
    };

    /** Only a stamped declaration can hold an out-of-reach reference; the rest
     *  is searched through the scope arrays that can hold one. */
    const visit = (declaration: ResourceManifest, prefix: string): void => {
      if (outsideScopesOf(declaration).length > 0) {
        check(declaration, prefix, new Map(), new Set());
        return;
      }
      for (const scope of shape(declaration).scopes) {
        scope.declarations.forEach((member, i) => {
          if (!isScopeMember(member)) return;
          visit(member, `${prefix ? `${prefix}.` : ""}${scope.path}[${i}]`);
        });
      }
    };

    visit(root, "");
  }

  return out;
}

/** The local name a `!ref` source names, or undefined for a cross-module one. */
function localName(source: string): string | undefined {
  const dot = source.indexOf(".");
  if (dot === -1) return source;
  return source.slice(0, dot) === "Self" ? source.slice(dot + 1) : undefined;
}

/** The local name a resolved `{kind, name, alias?}` reference names. */
function resolvedLocalName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as { kind?: unknown; name?: unknown; alias?: unknown };
  if (typeof ref.kind !== "string" || typeof ref.name !== "string") return undefined;
  if (typeof ref.alias === "string" && ref.alias !== "Self") return undefined;
  return ref.name;
}
