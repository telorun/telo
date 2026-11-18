import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isKindDocument } from "./kind-declaration.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { definitionInScope } from "./module-alias-scope.js";
import { isRefSentinel } from "@telorun/templating";
import {
  declaredScopes,
  keysUnder,
  outOfReachSentence,
  type DeclaredScope,
  type OutsideScope,
} from "./scope-declarations.js";
import { outOfReachNames, walkOwnCelExpressions } from "./scope-members.js";
import type { ScopeSite } from "./scope-address.js";
import { addressOf, scopeSiteAtPath } from "./scoped-name-resolver.js";
import { forEachStep, stepBodiesOf } from "./step-bodies.js";
import { parseKeys } from "./template-expansion.js";
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

/** Whether the places of `declaration` are judged: an instance of the entry's
 *  own modules. */
export function scopedNameReachJudged(declaration: ResourceManifest, rootModules: ReadonlySet<string>): boolean {
  if (!declaration.kind || isDeclarationDocument(declaration) || isForwardedDeclaration(declaration)) return false;
  const meta = declaration.metadata as { name?: unknown; module?: unknown } | undefined;
  if (typeof meta?.name !== "string") return false;
  const module = typeof meta.module === "string" ? meta.module : undefined;
  return !module || rootModules.has(module);
}

/** One place of a declaration naming a resource out of its reach, as written:
 *  its keys and the local name there. */
export interface ScopedNameReachSite {
  readonly keys: readonly (string | number)[];
  readonly name: string;
}

/** Every place of `declaration` naming one of the names out of its reach
 *  (`reach`), in each spelling a reference takes. */
export function scopedNameReachSites(
  declaration: ResourceManifest,
  reach: ReadonlyMap<string, OutsideScope>,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
): ScopedNameReachSite[] {
  const out: ScopedNameReachSite[] = [];
  const add = (name: string | undefined, path: string) => {
    if (name !== undefined && reach.has(name)) out.push({ keys: parseKeys(path), name });
  };
  const sites = registry.referenceSites(declaration, aliases, aliasesByModule);
  const scopes = declaredScopes(sites);
  const definition = definitionInScope<ResourceDefinition>(registry, declaration.kind, declaration.metadata, aliases, aliasesByModule);
  const schema = registry.effectiveSchemaOf(definition) as Record<string, any> | undefined;
  const siteInScopeArray = (keys: readonly (string | number)[]) => scopes.some((scope: DeclaredScope) => keysUnder(keys, scope.keys));
  // Tagged `!ref`s, anywhere but the declaration's own metadata; a scope
  // member's are its own.
  walkOwnCelExpressions(declaration, "", (source, path, engine) => {
    if (path === "metadata" || path.startsWith("metadata.")) return;
    if (engine === "ref") add(localName(source), path);
  });
  // A resolved reference, where the kind declares one.
  for (const site of sites) {
    if (site.refs.length === 0 || siteInScopeArray(site.keys)) continue;
    add(resolvedLocalName(site.data), site.path);
  }
  if (schema) {
    for (const body of stepBodiesOf(declaration as Record<string, unknown>, schema)) {
      forEachStep(body, schema, (step, stepPath) => add(resolvedLocalName(step[body.invokeField]), `${stepPath}.${body.invokeField}`));
    }
  }
  return out;
}

/** The local name the reference `value` names, in either spelling. */
export function scopedNameReachName(value: unknown): string | undefined {
  return isRefSentinel(value) ? localName(value.source) : resolvedLocalName(value);
}

/**
 * The finding at `path` of `declaration`, naming `name`, which is out of its
 * reach — none where a scope created around the place declares the name again
 * (`shadowed`).
 */
export function scopedNameReachFinding(
  declaration: ResourceManifest,
  name: string,
  path: string,
  shadowed: (name: string, within: ScopeSite | undefined) => boolean,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
): AnalysisDiagnostic | undefined {
  const scope = outOfReachNames(declaration).get(name);
  const address = addressOf(declaration);
  if (!scope || !address) return undefined;
  const scopes = declaredScopes(registry.referenceSites(declaration, aliases, aliasesByModule));
  if (shadowed(name, scopeSiteAtPath(address, scopes, path))) return undefined;
  const meta = declaration.metadata as { name?: unknown; source?: unknown };
  return {
    severity: DiagnosticSeverity.Error,
    code: "SCOPED_NAME_OUT_OF_REACH",
    source: SOURCE,
    message: `${scope.ownerKind}/${scope.ownerName}: ${outOfReachSentence(name, scope)}`,
    data: {
      resource: { kind: declaration.kind, name: meta.name as string },
      filePath: typeof meta.source === "string" ? meta.source : undefined,
      path,
    },
  };
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
