/**
 * **A catalog set holds each text once per language** — the kernel half of
 * `x-telo-text-catalog-set` (`text-catalog-set.ts` in the analyzer is the reader
 * both halves share).
 *
 * Before the controller of a resource whose kind marks a catalog set is created,
 * the set is gathered: every catalog the resource writes inside a marked node, and
 * the catalogs in the configuration each referenced resource's controller
 * received — continuing through the sets that resource's own kind marks — each
 * resource once. One text and context translated twice in one language across
 * them is `ERR_MESSAGE_ENTRY_DUPLICATE`, at the reference bringing in the later
 * one, worded as `telo check` words it.
 *
 * References are read off each declaration as it was registered — where a
 * template body's bare `self.<path>` already holds the instance it forwards —
 * never off the expanded copy, in which that instance may be a copy too.
 */
import {
  declaresTextCatalogSet,
  isResolvedReference,
  textCatalogSetDuplicates,
  textCatalogSetMembers,
  type NamedShapeResolver,
  type ReachSite,
  type TextCatalogSetHost,
} from "@telorun/analyzer";
import { isCompiledValue, RuntimeError, type ResourceManifest } from "@telorun/sdk";
import { receivedConfigurationOf } from "./callable-data-views.js";
import { authoredDeclarationOf } from "./declaration-scope.js";
import { declarationOfInstance } from "./instance-declaration.js";

/** What gathering a set reads from the kernel. */
export interface CatalogSetKernelHost {
  /** The configuration schema of a declaration's kind, resolved in its module. */
  schemaOf(declaration: ResourceManifest): Record<string, any> | undefined;
  readonly resolveRef: NamedShapeResolver;
  /** The concrete reference sites of a declaration. */
  sitesOf(declaration: ResourceManifest): readonly ReachSite[];
  /** What a reference `declaration` writes names, as Phase-5 injection looks it up. */
  instanceFor(declaration: ResourceManifest, name: string, alias?: string): unknown;
}

interface Held {
  readonly declaration: ResourceManifest;
  readonly configuration: unknown;
}

function readReference(value: unknown): { name: string; alias?: string } | undefined {
  if (!isResolvedReference(value)) return undefined;
  return { name: value.name, ...(value.alias !== undefined ? { alias: value.alias } : {}) };
}

/**
 * Refuses the first text a resource's catalog set translates twice in one
 * language. `declaration` is what the resource was declared with, `authored` the
 * same as registered (its references intact), `configuration` what its
 * controller is about to receive; `resolve`
 * names the instance a reference the resource writes names, throwing the
 * deferral injection throws for one not yet created.
 */
export function refuseCatalogSetDuplicates(input: {
  label: string;
  declaration: ResourceManifest;
  /** The declaration as it was registered, before compile-eval expansion. */
  authored: ResourceManifest;
  configuration: unknown;
  schema: Record<string, any>;
  resolve: (name: string, alias?: string) => unknown;
  host: CatalogSetKernelHost;
}): void {
  const { declaration, host } = input;
  if (!declaresTextCatalogSet(input.schema)) return;
  const holder: Held = { declaration, configuration: input.configuration };
  const heldOf = (instance: unknown): Held | undefined => {
    const referent = declarationOfInstance(instance);
    return referent ? { declaration: referent, configuration: receivedConfigurationOf(referent) } : undefined;
  };
  const setHost: TextCatalogSetHost<Held> = {
    isExpression: isCompiledValue,
    schemaOf: (held) => {
      const schema = held === holder ? input.schema : host.schemaOf(held.declaration);
      return schema ? { schema, resolveRef: host.resolveRef } : undefined;
    },
    configurationOf: (held) => held.configuration,
    // Read off the declaration as registered: compile-eval expansion copies a
    // live instance a template forwarded, and a copy names no declaration.
    referenceSites: (held) =>
      host
        .sitesOf(
          (held === holder ? input.authored : authoredDeclarationOf(held.declaration)) ?? held.declaration,
        )
        .filter((site) => site.refs.length > 0)
        .map((site) => ({ keys: site.keys, data: site.data })),
    resolve: (held, value) => {
      const ref = readReference(value);
      if (!ref) return heldOf(value);
      const instance =
        held === holder
          ? input.resolve(ref.name, ref.alias)
          : host.instanceFor(held.declaration, ref.name, ref.alias);
      return heldOf(instance);
    },
    identityOf: (held) => held.declaration,
    labelOf: (held) => `${held.declaration.kind}/${String(held.declaration.metadata?.name ?? "<inline>")}`,
  };
  const [duplicate] = textCatalogSetDuplicates(textCatalogSetMembers(holder, setHost), setHost);
  if (duplicate) {
    throw new RuntimeError("ERR_MESSAGE_ENTRY_DUPLICATE", `${input.label}: ${duplicate.message}`);
  }
}
