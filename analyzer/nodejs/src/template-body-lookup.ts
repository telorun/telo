/**
 * **What an entry of a template body holds when the template creates it** — the
 * analyzer's mirror of the kernel's template child context.
 *
 * A templated kind creates its `resources:` entries in a child context of its
 * own, rooted on the module that defines it. Phase-5 injection resolves a
 * reference an entry holds through that child's lookup, and the template's
 * `init()` expands each entry's expressions before the entry is created:
 *
 * - **references** ({@link templateBodyReference}): `<Alias>.<name>` reaches the
 *   export through the defining module's import; a bare name or `Self.<name>`
 *   reaches a sibling entry and nothing else. A resource of the defining module
 *   is NOT reached — the reference is left as written — so what such a name
 *   names is reported separately (`module`) rather than as a sibling;
 * - **expressions** ({@link expandedAtTemplateInit}): a node is expanded at
 *   `init()` unless the entry's kind evaluates its path itself (a runtime field,
 *   a CEL region, an accessor) AND it reads more than `self`, or is not
 *   repeatable (a non-deterministic call, a module call). A bare `self.<path>`
 *   is navigated, handing on what the consumer wrote — the consumer's to judge.
 *
 * - **declaration reads** ({@link bodyDeclarationRequests}): a reference read as
 *   a declaration — a contract the entry's kind derives from the entry — names a
 *   sibling entry first, then a declaration of the defining module,
 *   `<Alias>.<name>` through its imports, as the kernel reads one.
 *
 * Read by `validate-callable-data.ts`, whose verdict about a native function in
 * a template body must agree with what the kernel delivers there, and by the
 * template call site, whose contract the kernel decodes the same way.
 *
 * Browser-safe: no Node built-ins.
 */
import { rootReferences, type CelEnvironment } from "@telorun/cel";
import type { ResourceManifest } from "@telorun/sdk";
import { celExpressionsOf, repeatableSource } from "@telorun/templating";
import { buildCelEnvironment } from "./cel-environment.js";
import type { DeclarationRequests, NameRequests } from "./declaration-requests.js";
import { scopeAddress } from "./scope-address.js";
import { MANIFEST_READING, resolveScopedName } from "./scoped-name-resolver.js";

/** What a reference written in a template body entry names. `undecided` is a
 *  bare name no literal sibling holds while a sibling is named by an expression
 *  — the name may be that sibling's. */
export type TemplateBodyTarget =
  | { readonly kind: "sibling"; readonly name: string }
  | { readonly kind: "import"; readonly alias: string; readonly name: string }
  | { readonly kind: "module"; readonly name: string }
  | { readonly kind: "undecided" }
  | { readonly kind: "unresolved" };

/** What a body's lookup sees: its literally named siblings, whether any sibling
 *  is named by an expression, and the defining module's own declarations. */
export interface TemplateBodyScope {
  readonly siblings: ReadonlySet<string>;
  readonly dynamicSiblings: boolean;
  readonly moduleDeclares: (name: string) => boolean;
}

/** The target `ref` names inside a template body, as the template's child
 *  context resolves it at Phase-5 injection. */
export function templateBodyReference(
  ref: { readonly name: string; readonly alias?: string },
  scope: TemplateBodyScope,
): TemplateBodyTarget {
  if (ref.alias && ref.alias !== "Self") {
    return { kind: "import", alias: ref.alias, name: ref.name };
  }
  if (scope.siblings.has(ref.name)) return { kind: "sibling", name: ref.name };
  if (scope.dynamicSiblings) return { kind: "undecided" };
  if (scope.moduleDeclares(ref.name)) return { kind: "module", name: ref.name };
  return { kind: "unresolved" };
}

let environment: CelEnvironment | undefined;

/** True when the template's `init()` evaluates an expression an entry holds at a
 *  path the entry's kind evaluates itself: it reads nothing but `self` and is
 *  repeatable. Everywhere else in an entry the template evaluates every
 *  expression. */
export function expandedAtTemplateInit(tag: { readonly tag: string; readonly source: string }): boolean {
  environment ??= buildCelEnvironment();
  const env = environment;
  if (!repeatableSource(tag.tag, tag.source, env)) return false;
  return celExpressionsOf(tag.tag, tag.source).every((expression) => {
    const parsed = env.parse(expression);
    return parsed.diagnostics.length === 0 && rootReferences(parsed.root).every((name) => name === "self");
  });
}

/** A body's entries as the template creates them: each with a literal name,
 *  stamped with the defining module. */
export function bodyEntryDeclarations(
  definition: Record<string, any>,
  module: string | undefined,
): ResourceManifest[] {
  const entries = Array.isArray(definition.resources) ? definition.resources : [];
  return entries
    .filter(
      (entry: unknown): entry is Record<string, any> =>
        !!entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { kind?: unknown }).kind === "string" &&
        typeof (entry as { metadata?: { name?: unknown } }).metadata?.name === "string",
    )
    .map((entry: Record<string, any>) => ({ ...entry, metadata: { ...entry.metadata, module } }) as ResourceManifest);
}

/**
 * `requests` as a reference held by an entry of a body of `module` reads them:
 * a sibling of `siblings` shadows a declaration of `module` of the same name,
 * and every other name is answered by `requests`.
 */
export function bodyDeclarationRequests(
  requests: DeclarationRequests,
  siblings: readonly ResourceManifest[],
  module: string | undefined,
): DeclarationRequests {
  const byName = new Map<string, ResourceManifest>();
  for (const sibling of siblings) {
    const name = MANIFEST_READING.nameOf(sibling);
    if (name !== undefined && !byName.has(name)) byName.set(name, sibling);
  }
  if (byName.size === 0) return requests;
  const base = requests.names;
  const declarationsOf = (name: string): readonly ResourceManifest[] => {
    const sibling = byName.get(name);
    const below = base.declarationsOf(name);
    return sibling ? [sibling, ...below.filter((d) => MANIFEST_READING.moduleOf(d) !== module)] : below;
  };
  const names: NameRequests = {
    declarationsOf,
    scopeMember: (name, within) => base.scopeMember(name, within),
    inModule: (name, inModule, importPath) =>
      inModule === module && byName.has(name) ? byName.get(name) : base.inModule(name, inModule, importPath),
    locate(name, fromModule, within, accept) {
      if (!byName.has(name) || (within && base.scopeMember(name, within))) {
        return base.locate(name, fromModule, within, accept);
      }
      const candidates = declarationsOf(name);
      const declaration = resolveScopedName(accept ? candidates.filter(accept) : candidates, MANIFEST_READING.moduleOf, fromModule);
      return declaration === undefined
        ? undefined
        : { declaration, address: scopeAddress(MANIFEST_READING.moduleOf(declaration), name) };
    },
    resolve(name, fromModule, within, accept) {
      return this.locate(name, fromModule, within, accept)?.declaration;
    },
  };
  return {
    names,
    kindDocuments: () => requests.kindDocuments(),
    moduleDocuments: () => requests.moduleDocuments(),
    published: () => requests.published(),
    callables: () => requests.callables(),
    catchScope: () => requests.catchScope(),
    referrersOf: (m) => requests.referrersOf(m),
    ...(requests.holdsContentOf ? { holdsContentOf: (m: ResourceManifest) => requests.holdsContentOf!(m) } : {}),
    ...(requests.shapes ? { shapes: requests.shapes } : {}),
  };
}
