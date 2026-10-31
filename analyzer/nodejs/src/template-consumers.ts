/**
 * A TEMPLATE BODY AS EACH CONSUMER EXPANDS IT, for `telo check`.
 *
 * Every declaration of the entry's own modules whose kind runs a template body
 * holding an expansion construct gets that body expanded by what the consumer
 * wrote, through the one expansion the kernel also runs at the instance's
 * `init()` (`template-consumer-expansion.ts`). This file is the analyzer's
 * seams: a reference resolved by name through the scoped name resolver, and an
 * emitted item's forwarded value as a marker the forward views are built over.
 *
 * What the consumer is owed is reported where it wrote it: `REPEAT_COMPUTED`,
 * `BRANCH_UNDECIDABLE`, `REPEAT_NUMERIC_KEY`, `REPEAT_KEY_DUPLICATE`.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { moduleScopedDefResolver, type AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { readExpansionSites, type ExpansionSite } from "./expansion-sites.js";
import { controllerBearingAncestor, hasOwnControllerOrTemplate } from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { definitionInScope, moduleAliasScope } from "./module-alias-scope.js";
import { isModuleKind } from "./module-kinds.js";
import { isResolvedReference } from "./resolved-reference.js";
import { isInjectedDeclaration } from "./resource-input.js";
import { declarationOf, resolveReferenceOutcome, type NameResolution } from "./reference-resolution.js";
import {
  createConsumerExpander,
  forwardMarker,
  moduleOf,
  type ConsumerExpansion,
  type ConsumerLift,
} from "./template-consumer-expansion.js";
import { holdsTemplateConstructs } from "./template-definition-check.js";
import type { AnalysisDiagnostic } from "./types.js";

export type { ConsumerExpansion } from "./template-consumer-expansion.js";

export interface TemplateConsumers {
  /** The consumer's expanded runner body, by consumer. */
  readonly expansions: ReadonlyMap<ResourceManifest, ConsumerExpansion>;
  readonly diagnostics: readonly AnalysisDiagnostic[];
  /** Every expression a decision reads in a consumer's own values: the
   *  configuration reading takes their dimensions. */
  readonly reads: readonly { readonly holder: ResourceManifest; readonly source: string }[];
  /** Each value refused as computed or undecided: what else is found there is
   *  its consequence. */
  readonly refused: readonly { readonly holder: ResourceManifest; readonly path: string }[];
  /** The refusals whose value is chained to an input no configuration decides. */
  readonly open: ReadonlySet<AnalysisDiagnostic>;
}

export interface TemplateConsumerInputs {
  /** The declarations whose consumers are expanded. */
  readonly manifests: readonly ResourceManifest[];
  /** What a reference a consumer's value holds resolves to. */
  readonly names: NameResolution;
  readonly registry: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  /** The value `source`, written in `holder`, has in the configuration being
   *  analysed — undefined when the configuration does not decide it. */
  readonly decidedValue: (holder: ResourceManifest, source: string) => { value: unknown } | undefined;
  /** Whether a consumer's `targets:` are judged on its expansion (those of a
   *  dependency's template; the entry's own are judged at the definition). */
  readonly judgesTargets?: (runner: ResourceDefinition) => boolean;
  /** The modules whose consumers are expanded (default: `rootModules`). */
  readonly consumerModules?: ReadonlySet<string>;
  /** LIFTED: each consumer expanded over every configuration at once — its
   *  values the union's, every choice inside them an option node. */
  readonly lift?: ConsumerLift;
}

/** Expand every consumer's runner body. */
export function readTemplateConsumers(inputs: TemplateConsumerInputs): TemplateConsumers {
  const { manifests, registry, aliases, aliasesByModule, rootModules } = inputs;
  const consumerModules = inputs.consumerModules ?? rootModules;
  const scopes = { aliasesByModule, rootModules };
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(registry, aliases, scopes);
  const { names } = inputs;
  const expansions = new Map<ResourceManifest, ConsumerExpansion>();
  const sitesByRunner = new Map<ResourceDefinition, Map<unknown, ExpansionSite>>();

  const expander = createConsumerExpander({
    registry,
    aliases,
    aliasesByModule,
    declarationAt: (value, at, consumer) => {
      if (!isResolvedReference(value)) return undefined;
      const scope = moduleAliasScope(consumer.metadata, aliases, aliasesByModule);
      const declaration = declarationOf(resolveReferenceOutcome(
        names,
        value as { name: string; alias?: string },
        moduleOf(at.holder),
        (alias) => scope?.moduleForAlias(alias),
        undefined,
        at.holder,
      ));
      return { declaration, module: declaration ? moduleOf(declaration) : undefined };
    },
    emitted: (value, _instance, forward) => (forward ? forwardMarker(forward) : value),
    decidedValue: (holder, source) => inputs.decidedValue(holder, source),
    ...(inputs.lift ? { lift: inputs.lift } : {}),
    judgesTargets:
      inputs.judgesTargets ??
      ((runner) => {
        const module = moduleOf(runner as unknown as ResourceManifest);
        return module !== undefined && !rootModules.has(module);
      }),
  });

  for (const consumer of manifests) {
    if (!isConsumer(consumer, consumerModules)) continue;
    const definition = definitionInScope<ResourceDefinition>(
      registry,
      consumer.kind,
      consumer.metadata,
      aliases,
      aliasesByModule,
    );
    if (!definition || definition.kind !== "Telo.Definition") continue;
    // A `base:` child runs its parent's body over the mapping, which is no value
    // the consumer wrote at one place.
    if (!hasOwnControllerOrTemplate(definition) && (definition as { base?: unknown }).base != null) continue;
    const runner = hasOwnControllerOrTemplate(definition)
      ? definition
      : controllerBearingAncestor(definition, resolveDef);
    if (!runner || !holdsTemplateConstructs(runner as unknown as ResourceManifest)) continue;
    let sites = sitesByRunner.get(runner);
    if (!sites) {
      const reading = readExpansionSites(
        [runner as unknown as ResourceManifest],
        [],
        registry,
        aliases,
        aliasesByModule,
        true,
      );
      sites = new Map(reading.sites.filter((s) => s.refusal === undefined).map((s) => [s.value, s]));
      sitesByRunner.set(runner, sites);
    }
    expansions.set(consumer, expander.expand(consumer, runner, sites));
  }
  return {
    expansions,
    diagnostics: expander.records.diagnostics,
    reads: expander.records.reads,
    refused: expander.records.refused,
    open: expander.records.open,
  };
}

function isConsumer(m: ResourceManifest, consumerModules: ReadonlySet<string>): boolean {
  if (typeof m.kind !== "string" || typeof m.metadata?.name !== "string") return false;
  if (isModuleKind(m.kind) || m.kind.startsWith("Telo.")) return false;
  if (isForwardedDeclaration(m) || isInjectedDeclaration(m)) return false;
  const module = (m.metadata as { module?: unknown }).module;
  return typeof module !== "string" || consumerModules.has(module);
}
