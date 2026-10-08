/**
 * A DECLARATION AS A RULE READS IT — each `x-telo-eval: accessor` field replaced
 * by its binding.
 *
 * An accessor field names a value for the resource's consumer and is never
 * evaluated, so what it holds is known when the manifest is written: `{ root,
 * path }` for a chain, `{ value }` for a literal — what the kernel delivers to
 * the controller. A rule reading the tag instead met a "value not known until
 * creation" and skipped, on every resource that fills such a field.
 *
 * Both rule families read every declaration they bind through this view, and
 * only then scan for dynamic values. A malformed accessor stays tagged inside
 * `{ value }`, so a rule reading it still skips — and so does an expression a
 * template body's entry holds that reads only `self`, which is a literal of a
 * value not yet known by the time the entry is created. Each declaration is
 * read through its OWN kind's sites, an inline declaration beneath it through
 * the inline's kind, resolved in the holder's module scope. The bindings are
 * written by the accessor reader's one writer, which the kernel delivers with.
 *
 * One instance per analysis: a view is built once per declaration, and a
 * declaration with nothing to replace is returned by identity.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import { accessorFields, readsOnlySelf, withAccessorBindings } from "./accessor-binding.js";
import type { CelEvalSites } from "./eval-paths.js";
import { isInlineResource } from "./reference-field-map.js";

/** How one declaration is read: the eval sites of its kind, resolved in the
 *  scope of the module that declared it — absent where no CEL field rule governs
 *  the kind — and whether it is a template body's entry. */
export interface DeclarationReading {
  sites?: CelEvalSites;
  bodyEntry?: boolean;
}

/** `declaration` is the object a rule bound; `module` the scope an inline
 *  declaration inherits from its holder. */
export type DeclarationEvalSites = (
  declaration: Record<string, unknown> & { kind: string },
  module: unknown,
) => DeclarationReading | undefined;

function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (!value || typeof value !== "object" || isTaggedSentinel(value)) return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class RuleDeclarationViews {
  private readonly views = new WeakMap<object, unknown>();

  constructor(private readonly sitesOf: DeclarationEvalSites) {}

  of<T extends ResourceManifest>(declaration: T): T {
    const module = (declaration.metadata as { module?: unknown } | undefined)?.module;
    return this.view(declaration as unknown as Record<string, unknown>, module) as unknown as T;
  }

  private view(declaration: Record<string, unknown>, module: unknown): Record<string, unknown> {
    const cached = this.views.get(declaration);
    if (cached) return cached as Record<string, unknown>;
    const reading =
      typeof declaration.kind === "string"
        ? this.sitesOf(declaration as Record<string, unknown> & { kind: string }, module)
        : undefined;
    const fields = reading?.sites ? accessorFields(declaration, reading.sites) : [];
    const bound = withAccessorBindings(
      declaration,
      fields,
      reading?.bodyEntry ? readsOnlySelf : undefined,
    );
    const written = new Set(fields.map((field) => field.path));
    // Inline declarations beneath it, each through its own kind.
    const walk = (node: unknown, path: string): unknown => {
      if (written.has(path) || !isPlainContainer(node)) return node;
      if (Array.isArray(node)) {
        const items = node.map((item, index) => walk(item, `${path}[${index}]`));
        return items.some((item, index) => item !== node[index]) ? items : node;
      }
      if (path !== "" && isInlineResource(node)) return this.view(node, module);
      let copy: Record<string, unknown> | undefined;
      for (const [key, child] of Object.entries(node)) {
        const read = walk(child, path === "" ? key : `${path}.${key}`);
        if (read !== child) (copy ??= { ...node })[key] = read;
      }
      return copy ?? node;
    };
    const view = walk(bound, "") as Record<string, unknown>;
    this.views.set(declaration, view);
    return view;
  }
}
