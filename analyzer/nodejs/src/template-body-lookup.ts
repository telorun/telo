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
 * Read by `validate-callable-data.ts`, whose verdict about a native function in
 * a template body must agree with what the kernel delivers there.
 *
 * Browser-safe: no Node built-ins.
 */
import { rootReferences, type CelEnvironment } from "@telorun/cel";
import { celExpressionsOf, repeatableSource } from "@telorun/templating";
import { buildCelEnvironment } from "./cel-environment.js";

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
