import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isKindDocument } from "./kind-declaration.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { definitionInScope } from "./module-alias-scope.js";
import {
  declaredScopes,
  keysUnder,
  outOfReachSentence,
  type DeclaredScope,
} from "./scope-declarations.js";
import { outOfReachNames, walkOwnCelExpressions } from "./scope-members.js";
import {
  addressOf,
  MANIFEST_READING,
  scopeSiteAtPath,
  ScopedNameResolver,
} from "./scoped-name-resolver.js";
import { forEachStep, stepBodiesOf } from "./step-bodies.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { isResolvedReference } from "./resolved-reference.js";

const SOURCE = "telo-analyzer";

const isDeclarationDocument = (m: { kind?: unknown }): boolean =>
  m.kind === "Telo.Application" ||
  m.kind === "Telo.Library" ||
  m.kind === "Telo.Import" ||
  isKindDocument(m);

/**
 * `SCOPED_NAME_OUT_OF_REACH` — a declaration written inside a scope's region but
 * created outside the scope (see {@link OutsideScope}) naming one of the scope's
 * resources.
 *
 * Written there, the name reads as reachable — the scope's names shadow the
 * module's in its regions — while at run time it resolves to nothing, or to a
 * module-level resource that merely shares it. Reported at the reference, in
 * each spelling a reference takes:
 *
 *  - a `!ref` sentinel, anywhere — the tag is unambiguous;
 *  - a resolved `{kind, name}`, but ONLY where the declaring kind says a
 *    reference is: one of its reference sites, or a step's dispatch slot.
 *    An object that merely has those keys is data.
 *
 * A `resources.<name>` read is not a reference: the CEL `resources` record
 * lacks the name there, so it is `CEL_UNKNOWN_FIELD`, whose message carries the
 * same sentence.
 *
 * Lexical: a scope declared on the way from the out-of-reach declaration down to
 * the reference shadows the name again, since that one IS created around it. A
 * member of such a declaration's scope is out of reach as its holder is.
 * Entry-module-scoped: a dependency's code is its own analysis's to report.
 *
 * Browser-safe.
 */
export function validateScopedNameReach(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  // Every declaration, scope members filed under their scopes: a scope created
  // around a reference shadows an out-of-reach name again.
  const names = new ScopedNameResolver(manifests, MANIFEST_READING);

  for (const declaration of manifests) {
    if (!declaration.kind || isDeclarationDocument(declaration)) continue;
    if (isForwardedDeclaration(declaration)) continue;
    const meta = declaration.metadata as { name?: unknown; module?: unknown; source?: unknown } | undefined;
    if (typeof meta?.name !== "string") continue;
    const module = typeof meta.module === "string" ? meta.module : undefined;
    if (module && !rootModules.has(module)) continue;

    const reach = outOfReachNames(declaration);
    if (reach.size === 0) continue;

    const address = addressOf(declaration);
    if (!address) continue;
    const resource = { kind: declaration.kind, name: meta.name };
    const filePath = typeof meta.source === "string" ? meta.source : undefined;
    const sites = registry.referenceSites(declaration, aliases, aliasesByModule);
    const scopes = declaredScopes(sites);
    const definition = definitionInScope<ResourceDefinition>(
      registry,
      declaration.kind,
      declaration.metadata,
      aliases,
      aliasesByModule,
    );
    const schema = registry.effectiveSchemaOf(definition) as Record<string, any> | undefined;

    const test = (name: string | undefined, path: string) => {
      if (name === undefined) return;
      if (names.locate(name, module, scopeSiteAtPath(address, scopes, path))?.address.scope) return;
      const scope = reach.get(name);
      if (!scope) return;
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "SCOPED_NAME_OUT_OF_REACH",
        source: SOURCE,
        message: `${scope.ownerKind}/${scope.ownerName}: ${outOfReachSentence(name, scope)}`,
        data: { resource, filePath, path },
      });
    };
    const siteInScopeArray = (keys: readonly (string | number)[]) =>
      scopes.some((scope: DeclaredScope) => keysUnder(keys, scope.keys));

    // Tagged `!ref`s, anywhere but the declaration's own metadata; a scope
    // member's are its own.
    walkOwnCelExpressions(declaration, "", (source, path, engine) => {
      if (path === "metadata" || path.startsWith("metadata.")) return;
      if (engine === "ref") test(localName(source), path);
    });

    // A resolved reference, where the kind declares one.
    for (const site of sites) {
      if (site.refs.length === 0 || siteInScopeArray(site.keys)) continue;
      test(resolvedLocalName(site.data), site.path);
    }
    if (schema) {
      for (const body of stepBodiesOf(declaration as Record<string, unknown>, schema)) {
        forEachStep(body, schema, (step, stepPath) =>
          test(resolvedLocalName(step[body.invokeField]), `${stepPath}.${body.invokeField}`),
        );
      }
    }
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
  if (!isResolvedReference(value)) return undefined;
  if (value.alias !== undefined && value.alias !== "Self") return undefined;
  return value.name;
}
