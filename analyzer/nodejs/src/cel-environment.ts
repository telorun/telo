import {
  CelEnvironment,
  parseExpression,
  type CelExpression,
  type CelValue,
} from "@telorun/cel";
import { VALUE_TYPES, type ResourceManifest } from "@telorun/sdk";
import { celNamespaceNames, registerValueBrands } from "@telorun/templating";
import { authoredModuleMetadata, moduleMetadataSchema } from "./module-metadata-scope.js";
import { jsonSchemaToCelType, VALUE_BRAND_BASE } from "./schema-compat.js";
import { inferredStepsCelSchema, registerTypedSteps } from "./step-result-inference.js";

/** Transport protocol on a `ports` entry → the nominal CEL brand its resolved
 *  value carries. Mirrors the `protocol` enum in the Application schema, and
 *  names the value types by their canonical `Telo.`-qualified names — the same
 *  spelling an author writes at `x-telo-type`, so a branded port and a branded
 *  field are comparable by name with nothing in between to translate. */
const PORT_PROTOCOL_BRAND: Record<string, string> = {
  tcp: "Telo.TcpPort",
  udp: "Telo.UdpPort",
};

export { buildCelEnvironment } from "@telorun/templating";
export type { CelHandlers } from "@telorun/templating";

/**
 * The resolved tree of one expression, or undefined when its source does not
 * read whole — a syntax error is the CEL engine pass's to report, never a
 * chain walk's.
 *
 * **Reading needs no environment.** The tree is a function of the text and of
 * the names that denote MODULES at the site: `Billing.total(x)` is a qualified
 * call where `Billing` is one of them and a method on a value where it is not,
 * and the engine resolves that as the expression is read (`namespaces`). So a
 * caller that only walks a tree parses here instead of cloning an environment
 * per site, and a caller that also type-checks hands its own typed environment
 * the tree it already has.
 */
export function parseCelSource(
  source: string,
  moduleNames?: ReadonlySet<string>,
): CelExpression | undefined {
  const namespaces = moduleNames ? celNamespaceNames(moduleNames) : undefined;
  const parsed = parseExpression(source, namespaces ? { namespaces } : undefined);
  return parsed.diagnostics.length > 0 ? undefined : parsed;
}

// The module-name filter and the dispatch adapter are templating's, which owns
// the name set (`CompileEnv.moduleNames`) and the one host seam a module
// function's arguments cross. A copy here answered the filter identically and
// the adapter DIFFERENTLY — it called the bound function with raw values, so a
// map literal at a call site was a `CelMap` at `telo check` and a plain object
// at run.
export { celNamespaceNames, namespaceDispatchOf } from "@telorun/templating";

/**
 * Declare the declaring module's own names as CEL namespaces, so that
 * `Billing.total(x)` read against this environment is a qualified call rather
 * than a method on a value, and its RESULT carries the callee's declared type.
 *
 * **Open, and the parameter list is withheld, both deliberately.** Whether a
 * call reaches a function at all is the analyzer's verdict — the export gate,
 * the dependency edge, the capability, the re-export chain are vocabulary the
 * engine does not hold — so a name the module declares nothing for types `dyn`
 * and is reported by `FUNCTION_UNRESOLVED` / `_NOT_EXPORTED` / `_NOT_CALLABLE`
 * here. Arity and arguments are withheld for the same reason and a stronger
 * one: a callable's signature carries a JSON Schema per parameter and an
 * optional trailing parameter, which is strictly more than CEL assignability
 * can judge, and `FUNCTION_ARITY_MISMATCH` / `_ARGUMENT_MISMATCH` are the
 * analyzer's own.
 */
export function registerModuleNamespaces(
  env: CelEnvironment,
  moduleNames: ReadonlySet<string>,
  callablesThrough: (receiver: string) => readonly { name: string; celType: string }[],
): void {
  for (const receiver of celNamespaceNames(moduleNames)) {
    env.registerNamespace(
      receiver,
      callablesThrough(receiver).map(({ name, celType }) => ({ name, returns: celType })),
      { open: true },
    );
  }
}


/** How many name-set environments one base environment keeps. Keyed on a
 *  module's own names, so the live set is bounded by the workspace — but a
 *  long-lived host (an editor, a watch session) sees new ones as files are
 *  edited, and an unbounded map keyed on an author's input is a leak. */
const MODULE_NAMES_ENV_CAPACITY = 64;

const moduleNamesEnvByBase = new WeakMap<CelEnvironment, Map<string, CelEnvironment>>();

/**
 * `base` with `moduleNames` declared as open namespaces and nothing else — for
 * a pass that reads an expression's CALLS without typing its site.
 *
 * Such a pass declares no function: it asks which calls the expression makes,
 * not what one answers, so every name a namespace reaches types `dyn` and is
 * listed. A pass that also types the site builds its own environment and
 * declares the callables on it ({@link registerModuleNamespaces}).
 *
 * Least-recently-used and bounded; a base environment holding no namespaces is
 * itself the answer for an empty set.
 */
export function moduleNamesEnvironment(
  base: CelEnvironment,
  moduleNames: ReadonlySet<string>,
): CelEnvironment {
  const names = celNamespaceNames(moduleNames);
  if (names.size === 0) return base;
  let byNames = moduleNamesEnvByBase.get(base);
  if (!byNames) moduleNamesEnvByBase.set(base, (byNames = new Map()));
  const key = [...names].sort().join(",");
  const cached = byNames.get(key);
  if (cached) {
    byNames.delete(key);
    byNames.set(key, cached);
    return cached;
  }
  const env = base.clone();
  for (const name of names) env.registerNamespace(name, [], { open: true });
  if (byNames.size >= MODULE_NAMES_ENV_CAPACITY) {
    byNames.delete(byNames.keys().next().value!);
  }
  byNames.set(key, env);
  return env;
}

/** Clone `baseEnv` and register typed variable declarations so that
 *  `env.check(expr)` can infer return types for expressions referencing known variables.
 *
 *  - `variables`: typed from the manifest's `variables` field if it is a schema map
 *    (only module-identity docs — `Telo.Application` / `Telo.Library` — carry this); otherwise registered as `map` (dyn).
 *  - `secrets`, `resources`: always `map` (dyn — output schemas unknown).
 *  - `extraContextSchema`: additional variables from an `x-telo-context` annotation.
 *
 *  NOTE: The set of kernel globals registered here must match `KERNEL_GLOBAL_NAMES`
 *  in kernel-globals.ts, which is used for chain-access validation. */
export function buildTypedCelEnvironment(
  baseEnv: CelEnvironment,
  manifest: ResourceManifest,
  extraContextSchema?: Record<string, any> | null,
  // The `ports` namespace is Application-only and lives on the module doc, not
  // on the resource being analyzed. When validating a resource, the caller
  // passes the module manifest here so `!cel "ports.X"` types cross-doc.
  rootModuleManifest?: ResourceManifest,
): CelEnvironment {
  try {
    const env = baseEnv.clone();

    // Register nominal value brands (TcpPort/UdpPort/…) on the *clone* so the
    // type-checker can distinguish structurally-identical values. The base env
    // (shared with the kernel runtime) is untouched — a branded value flows as
    // a plain integer at runtime, so only static checking needs these. A
    // nominal type is declared, never implemented: the engine takes the
    // conversions and members as signatures, so no runtime constructor exists.
    registerValueBrands(env);

    // `variables` / `secrets`: the DECLARING module's blocks, which is the
    // contract the resource's CEL is evaluated against at runtime. Read the
    // same three ways `ports` and `module` are, and for the same reason — a
    // resource doc does not carry them, so typing from `manifest` alone left
    // every ordinary resource with an open `variables` and no check at all,
    // while `ports.<typo>` one line away was an error.
    //
    // Order matters: a module-identity doc analyzing itself carries its own
    // block; a resource forwarded from an imported library carries its
    // library's as `metadata.moduleGlobals`, which must win over the consuming
    // application's; everything else is the entry module's own doc.
    const moduleGlobals = (manifest.metadata as Record<string, any> | undefined)?.moduleGlobals as
      | Record<string, unknown>
      | undefined;
    // A KIND document is the exception, and it is not a detail: the CEL inside
    // a `Telo.Definition`'s `schema:` — an `examples:` entry, a `description`
    // showing `!cel "secrets.API_KEY"` — illustrates what a CONSUMER writes, in
    // the consumer's scope. Closing those over the declaring module's blocks
    // reported an error against a name the module never meant to declare, and
    // one nobody could fix without deleting the example.
    const root = (
      isKindDocument(manifest) ? undefined : (rootModuleManifest as Record<string, unknown>)
    ) as Record<string, unknown> | undefined;
    registerConfigNamespace(
      env,
      (manifest as Record<string, unknown>).variables ?? moduleGlobals?.variables ?? root?.variables,
      "variables",
    );

    // `ports` namespace: each entry types as the brand its `protocol` selects
    // (tcp → TcpPort, udp → UdpPort), so `!cel "ports.http"` carries a nominal
    // type that consuming fields can check against.
    const portsManifest = ((rootModuleManifest ?? manifest) as Record<string, unknown>).ports;
    if (portsManifest !== null && typeof portsManifest === "object" && !Array.isArray(portsManifest)) {
      const portEntries = Object.entries(portsManifest as Record<string, any>).filter(
        ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v),
      );
      if (portEntries.length > 0) {
        const schema: Record<string, string> = {};
        for (const [k, v] of portEntries) {
          schema[k] = PORT_PROTOCOL_BRAND[(v as { protocol?: string }).protocol ?? "tcp"] ?? "int";
        }
        env.registerVariable("ports", { fields: schema });
      } else {
        env.registerVariable("ports", "map");
      }
    } else {
      env.registerVariable("ports", "map");
    }

    registerConfigNamespace(
      env,
      (manifest as Record<string, unknown>).secrets ?? moduleGlobals?.secrets ?? root?.secrets,
      "secrets",
    );
    env.registerVariable("resources", "map");

    // `module` — the declaring module's own `metadata`, so a manifest reads its
    // version instead of restating it. A resource forwarded from an imported
    // library reads THAT library's metadata, stamped as
    // `metadata.moduleGlobals.module`.
    //
    // Falls back to an OPEN map, never to `manifest.metadata`: for a resource
    // doc that is the RESOURCE's metadata (`{name: <resource name>}`), and
    // closing `module` over it would turn a `module.version` that resolves
    // perfectly well at runtime into a hard error the author cannot act on. A
    // static check that is wrong in the rejecting direction is the worse
    // polarity.
    const moduleSchema = moduleMetadataSchema(
      ((manifest.metadata as Record<string, any> | undefined)?.moduleGlobals?.module as
        | Record<string, unknown>
        | undefined) ?? (rootModuleManifest?.metadata as Record<string, unknown> | undefined),
    );
    if (moduleSchema) {
      const schema: Record<string, string> = {};
      for (const [key, property] of Object.entries(moduleSchema.properties as Record<string, any>)) {
        schema[key] = jsonSchemaToCelType(property);
      }
      env.registerVariable("module", { fields: schema });
    } else {
      env.registerVariable("module", "map");
    }

    if (extraContextSchema?.properties) {
      const properties = extraContextSchema.properties as Record<string, any>;
      const bound: string[] = [];
      for (const [name, propSchema] of Object.entries(properties)) {
        if (name === "steps" || env.hasVariable(name)) continue;
        const celType = jsonSchemaToCelType(propSchema as Record<string, any>);
        env.registerVariable(name, celType);
        bound.push(`${name}:${celType}`);
      }
      // Last, so a pure step's expression is typed against every other name.
      // Inference probes clones of `env`, so the typed `steps` goes onto a
      // clone of its own and the probes stay typed without it.
      const steps = properties.steps as Record<string, any> | undefined;
      if (steps && !env.hasVariable("steps")) {
        const inferred = inferredStepsCelSchema(steps, env, bound.sort().join(","));
        if (inferred) {
          const typed = env.clone();
          registerTypedSteps(typed, inferred);
          return typed;
        }
        env.registerVariable("steps", jsonSchemaToCelType(steps));
      }
    }

    return env;
  } catch {
    return baseEnv.clone();
  }
}

/** CEL environment for a parameter scope (`x-telo-context-parameters-from`): the
 *  catalog plus the scope's own bindings, and none of the kernel globals — so a
 *  read of `variables` / `resources` / … is an unknown identifier rather than a
 *  read of state the expression's arguments do not carry. Module calls stay
 *  reachable: they resolve on the parsed tree, not through a variable. */
export function buildParameterCelEnvironment(
  baseEnv: CelEnvironment,
  contextSchema: Record<string, any> | null,
): CelEnvironment {
  const env = baseEnv.clone();
  registerValueBrands(env);
  for (const [name, propSchema] of Object.entries(
    (contextSchema?.properties ?? {}) as Record<string, any>,
  )) {
    env.registerVariable(name, jsonSchemaToCelType(propSchema as Record<string, any>));
  }
  return env;
}

/**
 * A kind document — whose CEL is written for whoever instantiates the kind, not
 * evaluated in the declaring module's own scope.
 *
 * Its `examples:` show a consumer's route reading `request` and `result`, its
 * `description`s show `!cel "secrets.API_KEY"`, and a rule condition reads the
 * `self` / `referrer` its own evaluator binds. None of those names are in scope
 * where they are WRITTEN, and all of them are correct where they are READ — so
 * every check that asks "is this name in scope here" has to stand down on these
 * documents, or it reports errors nobody can fix without deleting the example.
 */
export function isKindDocument(manifest: ResourceManifest): boolean {
  return manifest.kind === "Telo.Definition" || manifest.kind === "Telo.Abstract";
}

/**
 * What a checker rejection of an expression reading a brand should add: the
 * operations {@link registerValueBrands} gives it. A brand is a type of its own,
 * so an operator its base accepts (`+` on a string) finds no overload, and the
 * checker's wording says only that. The brand comes from the engine's checked
 * `readTypes`, never from the checker's wording.
 */
export function valueBrandHint(readTypes: readonly string[] | undefined): string {
  const brand = readTypes?.find((type) => VALUE_BRAND_BASE[type] !== undefined);
  if (!brand) return "";
  const base = VALUE_BRAND_BASE[brand]!;
  const join =
    VALUE_TYPES.get(brand)?.fromHost !== undefined
      ? `, or extend it with .joinPath('sub/dir'), which keeps it a ${brand}`
      : "";
  return ` ('${brand}' is a type of its own: read it as its base with ${base}(…)${join}.)`;
}

/** Register a `variables`/`secrets` namespace typed from a module doc's schema map
 *  (`{ name: <schema>, … }`), falling back to dyn `map` when absent or untyped. */
function registerConfigNamespace(
  env: CelEnvironment,
  block: unknown,
  name: "variables" | "secrets",
): void {
  if (block !== null && typeof block === "object" && !Array.isArray(block)) {
    const entries = Object.entries(block as Record<string, unknown>).filter(
      ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v),
    );
    if (entries.length > 0) {
      const schema: Record<string, string> = {};
      for (const [k, v] of entries) schema[k] = jsonSchemaToCelType(v as Record<string, any>);
      env.registerVariable(name, { fields: schema });
      return;
    }
  }
  env.registerVariable(name, "map");
}

/** CEL environment for the `variables:`/`secrets:` expressions on a `Telo.Import`.
 *
 *  Import inputs are a config-only contract: their expressions are evaluated
 *  against the IMPORTING module's `variables`/`secrets`, never the import's own
 *  values map (the bug) nor the imported child's. `resources` and `ports`
 *  are registered as empty typed objects, so referencing them is a "No such key"
 *  error that steers authors to a typed `variables` entry. */
export function buildImportInputCelEnvironment(
  baseEnv: CelEnvironment,
  moduleManifest: ResourceManifest | undefined,
): CelEnvironment {
  const env = baseEnv.clone();
  registerValueBrands(env);
  const mod = moduleManifest as Record<string, unknown> | undefined;
  // Typing variables/secrets from the importer's schema can fail on a malformed
  // schema; degrade those to permissive `map` if so — but never lose the
  // resources/env/ports rejection registered below (the catch is scoped so a
  // typing failure can't silently re-open the config-only contract).
  try {
    registerConfigNamespace(env, mod?.variables, "variables");
    registerConfigNamespace(env, mod?.secrets, "secrets");
  } catch {
    env.registerVariable("variables", "map");
    env.registerVariable("secrets", "map");
  }
  // Override the base env's dyn `resources`/`ports` with empty typed objects
  // so any access (`resources.X`, `ports.X`) is a "No such key" error — these
  // surfaces are not part of the config-only import contract.
  for (const name of ["resources", "ports"]) {
    env.registerVariable(name, { fields: {} });
  }
  // `module` IS part of it: the importer's own identity is config, and passing
  // its version down to a child is the case the binding exists for.
  const metadata = authoredModuleMetadata(mod?.metadata as Record<string, unknown> | undefined);
  if (Object.keys(metadata).length > 0) {
    const schema: Record<string, string> = {};
    for (const key of Object.keys(metadata)) schema[key] = "dyn";
    env.registerVariable("module", { fields: schema });
  } else {
    env.registerVariable("module", "map");
  }
  return env;
}
