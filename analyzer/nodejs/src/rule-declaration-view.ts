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
 * A declaration another module exported is read with its references in the form
 * a local declaration's have. The pass that rewrites a `!ref` into `{ kind,
 * name, alias? }` does not walk a dependency's declaration — its names belong to
 * its own module — so a rule reading a member of such a reference met the tag
 * and failed to evaluate, where the identical rule over a local declaration ran.
 * Each reference a forwarded declaration writes is resolved here in the scope of
 * the module that declared it; one that resolves to nothing is left as written.
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
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { refSentinelTarget, type RefSentinelTarget } from "./ref-sentinel-target.js";
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

/** What a reference written in `module` names, in the form a resolved local
 *  reference takes — or nothing, when that module's scope holds no such name. */
export type ForwardedReference = (
  target: RefSentinelTarget,
  module: string,
) => { kind: string; name: string; alias?: string } | undefined;

function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (!value || typeof value !== "object" || isTaggedSentinel(value)) return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class RuleDeclarationViews {
  private readonly views = new WeakMap<object, unknown>();

  constructor(
    private readonly sitesOf: DeclarationEvalSites,
    /** Resolves a reference a dependency's declaration writes. Without it such a
     *  reference is read as written. */
    private readonly forwardedReference?: ForwardedReference,
  ) {}

  of<T extends ResourceManifest>(declaration: T): T {
    const module = (declaration.metadata as { module?: unknown } | undefined)?.module;
    return this.view(
      declaration as unknown as Record<string, unknown>,
      module,
      isForwardedDeclaration(declaration),
    ) as unknown as T;
  }

  /** `forwarded`: the declaration is a dependency's, or an inline declaration
   *  beneath one. */
  private view(
    declaration: Record<string, unknown>,
    module: unknown,
    forwarded: boolean,
  ): Record<string, unknown> {
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
    const resolve =
      forwarded && typeof module === "string" ? this.forwardedReference : undefined;
    const walk = (node: unknown, path: string): unknown => {
      if (written.has(path)) return node;
      if (resolve) {
        const target = refSentinelTarget(node);
        if (target) return resolve(target, module as string) ?? node;
      }
      if (!isPlainContainer(node)) return node;
      if (Array.isArray(node)) {
        const items = node.map((item, index) => walk(item, `${path}[${index}]`));
        return items.some((item, index) => item !== node[index]) ? items : node;
      }
      if (path !== "" && isInlineResource(node)) return this.view(node, module, forwarded);
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
