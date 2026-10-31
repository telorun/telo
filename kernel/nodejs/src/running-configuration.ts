/**
 * The configuration a module starts in, and its documents expanded for it.
 *
 * Every `!if` / `!switch` outside a template body is decided by the
 * dimensions it reads: the kernel resolves those inputs first, refusing a
 * value outside its domain before any resource exists, then asks the
 * analyzer's one choice reading for the branch each choice takes — in the
 * scope the load's registry holds, so a module call a condition makes is
 * evaluated as `telo check` evaluates it — and expands the documents with the
 * analyzer's one expansion. The documents a module registers are exactly those
 * `telo check` analysed for this configuration, and an unchosen branch is
 * never registered, created or loaded.
 */
import {
  assignmentOf,
  choiceScopeOf,
  expandChoices,
  readChoices,
  STAND_IN,
  DiagnosticSeverity,
  type AnalysisDiagnostic,
  type AnalysisRegistry,
  type Assignment,
  type ChoiceReading,
  type Dimension,
  type NeedTable,
} from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { isExpansionSentinel } from "@telorun/templating";
import type { ApplicationInputs } from "./application-env.js";
import { refuseExpansionConstructs } from "./expansion-refusals.js";

/** What a module's inputs resolve to, for the dimensions asked for — a need's
 *  fields by need path, `null` where nothing fulfils it. */
export type DimensionInputs = {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, unknown>>;
  readonly needs?: ReadonlyMap<string, Readonly<Record<string, unknown>> | null>;
};

/** The inputs a configuration's dimensions read: entries by block, needs by
 *  need path. */
export type DimensionInputNames = {
  variables: Set<string>;
  secrets: Set<string>;
  needs: Set<string>;
};

export interface RunningConfiguration {
  /** Each dimension's value, keyed by the path it is read at. */
  readonly configuration: Assignment;
  /** The inputs resolved to decide it. */
  readonly inputs: DimensionInputs;
}

/** The inputs `dimensions` read. */
function dimensionInputNames(dimensions: readonly Dimension[]): DimensionInputNames {
  const out: DimensionInputNames = { variables: new Set(), secrets: new Set(), needs: new Set() };
  for (const dimension of dimensions) {
    if (dimension.input === "resources") out.needs.add(dimension.name);
    else out[dimension.input].add(dimension.name);
  }
  return out;
}

function choicesOf(
  manifests: readonly ResourceManifest[],
  registry: AnalysisRegistry,
  related?: readonly ResourceManifest[],
  needTable?: NeedTable,
): { choices: ChoiceReading; declarations: ResourceManifest[] } {
  const documents = manifests.filter(isExpansionSentinel);
  const declarations = documents.length > 0 ? manifests.filter((m) => !isExpansionSentinel(m)) : [...manifests];
  return {
    choices: readChoices(declarations, documents, choiceScopeOf(declarations, registry, related, needTable)),
    declarations,
  };
}

/** The choices of the application whose analysed set is `manifests` — its own
 *  documents and every library document forwarded into it, so a dimension a
 *  library's choice reaches through an import binding is one too — read in the
 *  scope the load's registry holds, a need a library leaves to the environment
 *  read through `needTable`. */
export function applicationChoices(
  manifests: readonly ResourceManifest[],
  registry: AnalysisRegistry,
  needTable?: NeedTable,
): ChoiceReading {
  return choicesOf(manifests, registry, undefined, needTable).choices;
}

/**
 * The configuration an application starts in: the value of each of
 * `dimensions` (`requirementDimensionsOf` — its choices' own, and the presence of
 * each optional need a library leaves to the environment). `resolve` is handed
 * the inputs the dimensions read and returns their values (undefined when it
 * answered `--help`).
 */
export async function decideRunningConfiguration(
  dimensions: readonly Dimension[],
  resolve: (names: DimensionInputNames) => Promise<DimensionInputs | undefined>,
): Promise<RunningConfiguration | undefined> {
  if (dimensions.length === 0) return { configuration: {}, inputs: { variables: {}, secrets: {} } };
  const inputs = await resolve(dimensionInputNames(dimensions));
  if (!inputs) return undefined;
  return { configuration: assignmentOf(dimensions, inputs), inputs };
}

/** `manifests` as `configuration` expands them: the branch each choice takes,
 *  and nothing of an unchosen one. `related` holds the dependencies' forwarded
 *  declarations a call a condition makes may reach. */
export function expandForConfiguration(
  manifests: readonly ResourceManifest[],
  configuration: Assignment,
  registry: AnalysisRegistry,
  related?: readonly ResourceManifest[],
  needTable?: NeedTable,
): ResourceManifest[] {
  const { choices, declarations } = choicesOf(manifests, registry, related, needTable);
  if (choices.sites.length === 0) return declarations;
  return expandChoices(manifests, decided(choices, configuration)).manifests;
}

/**
 * A library's documents expanded for one import: its dimensions read off the
 * import's settled `variables:` / `secrets:` and the needs it bound — each read
 * from what the load already resolved, never from the environment again.
 * `related` holds the forwarded declarations of the library's own imports,
 * which a call its conditions make may reach.
 */
export function expandForImport(
  manifests: readonly ResourceManifest[],
  inputs: DimensionInputs,
  registry: AnalysisRegistry,
  related: readonly ResourceManifest[],
): ResourceManifest[] {
  const { choices, declarations } = choicesOf(manifests, registry, related);
  if (choices.sites.length === 0) return declarations;
  return expandChoices(manifests, decided(choices, assignmentOf(choices.dimensions, inputs))).manifests;
}

/** The branch every choice takes in `configuration`. One of the module's own
 *  choices nothing decides there is refused before anything is registered, by
 *  the refusals the reading owes it — the load's analysis reports them first,
 *  so reaching one here means it was not run. A dependency's forwarded choice
 *  is refused by the import that loads it. */
function decided(choices: ChoiceReading, configuration: Assignment) {
  const decisions = choices.decide(configuration);
  const undecided = choices.sites.filter((site) => site.own && decisions.get(site.sentinel) === STAND_IN);
  if (undecided.length > 0) {
    const refusals: AnalysisDiagnostic[] = choices.diagnostics
      .map((found) => found.diagnostic)
      .filter((d) => d.severity === DiagnosticSeverity.Error);
    refuseExpansionConstructs(
      refusals.length > 0
        ? refusals
        : undecided.map((site) => ({
            severity: DiagnosticSeverity.Error,
            code: "BRANCH_UNDECIDABLE",
            source: "telo-kernel",
            message: `'!${site.tag}' is not decided in the configuration this process started in.`,
          })),
    );
  }
  return decisions;
}

/** `inputs` with the dimensions already resolved supplied by name, so the
 *  load's full read neither reads nor asks for one again. */
export function withDimensionInputs(
  inputs: ApplicationInputs | undefined,
  dimensions: DimensionInputs | undefined,
): ApplicationInputs | undefined {
  if (!dimensions) return inputs;
  const variables = { ...dimensions.variables, ...inputs?.variables };
  const secrets = { ...dimensions.secrets, ...inputs?.secrets };
  if (Object.keys(variables).length === 0 && Object.keys(secrets).length === 0) return inputs;
  return { ...inputs, variables, secrets };
}
