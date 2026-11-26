import {
  CelEnvironment,
  parseExpression,
  type CelExpression,
  type SchemaTypeResolver,
  type CelType,
} from "@telorun/cel";
import { moduleInputBlock } from "./text-parameter.js";
import { celTypeOfValueType, VALUE_TYPES, valueTypeOf, type ResourceManifest } from "@telorun/sdk";
import { celNamespaceNames } from "@telorun/templating";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import { authoredModuleMetadata, moduleMetadataSchema } from "./module-metadata-scope.js";
import { admitsAbsence } from "./configuration-dimensions.js";
import { VALUE_BRAND_BASE } from "./schema-compat.js";
import { celSchemaResolver } from "./cel-schema-resolver.js";
import { recordHandedSchema } from "./schema-unjudged.js";
import { CONTEXT_WITHHELD } from "./context-withheld.js";
import { isStepRecord, stepRecordSchema } from "./step-result-inference.js";

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
  callablesThrough: (
    receiver: string,
  ) => readonly { name: string; celType: string; returns?: Record<string, any> }[],
): void {
  for (const receiver of celNamespaceNames(moduleNames)) {
    env.registerNamespace(
      receiver,
      // A declared result is a schema the engine reads through the
      // environment's resolver, references included.
      callablesThrough(receiver).map(({ name, celType, returns }) => {
        if (returns) recordHandedSchema(env, `${receiver}.${name}`, returns);
        return { name, returns: returns ? { schema: returns } : celType };
      }),
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
 *  `env.check(expr)` types every read to full depth.
 *
 *  Every binding is handed to the engine as its JSON Schema, read through
 *  `resolver` — the one resolver of named shapes and value types:
 *
 *  - `variables` / `secrets`: the context's (the kernel globals the site
 *    reads), else the declaring module's block — the manifest's own when it
 *    is a module doc, else its `moduleGlobals` stamp, else
 *    `rootModuleManifest`'s; `map` (dyn) when none declares one.
 *  - `resources`: the context's record of readings, else `map`.
 *  - `ports` / `module`: from the module doc.
 *  - every other name the context declares, `steps` as its closed record.
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
  resolver?: SchemaTypeResolver,
): CelEnvironment {
  const env = baseEnv.clone({ resolveSchemaType: resolver ?? celSchemaResolver(baseEnv, undefined) });

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
  // Only a module doc DECLARES its blocks. On any other doc a `variables:` /
  // `secrets:` field is values supplied to something else — an import's
  // inputs, a child application's — never the scope its own CEL reads.
  const declaring = isModuleKind(manifest.kind)
    ? (manifest as Record<string, unknown>)
    : undefined;
  const context = (extraContextSchema?.properties ?? {}) as Record<string, any>;
  for (const name of ["variables", "secrets"] as const) {
    if (isSchemaNode(context[name])) registerBinding(env, name, context[name]);
    else {
      // A library's text parameter reads as the record its importer hands over.
      const block = moduleInputBlock(declaring, name) ?? moduleGlobals?.[name] ?? moduleInputBlock(root, name);
      registerConfigNamespace(env, block, name);
    }
  }

  // `ports` namespace: each entry types as the brand its `protocol` selects
  // (tcp → TcpPort, udp → UdpPort), so `!cel "ports.http"` carries a nominal
  // type that consuming fields can check against.
  const portsManifest = ((rootModuleManifest ?? manifest) as Record<string, unknown>).ports;
  const portEntries =
    portsManifest !== null && typeof portsManifest === "object" && !Array.isArray(portsManifest)
      ? Object.entries(portsManifest as Record<string, any>).filter(
          ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v),
        )
      : [];
  if (portEntries.length > 0) {
    const properties: Record<string, any> = {};
    for (const [k, v] of portEntries) {
      const brand = PORT_PROTOCOL_BRAND[(v as { protocol?: string }).protocol ?? "tcp"];
      properties[k] = brand ? { "x-telo-type": brand } : { type: "integer" };
    }
    registerBinding(env, "ports", { type: "object", properties, additionalProperties: false });
  } else {
    env.registerVariable("ports", "map");
  }

  if (isSchemaNode(context.resources)) registerBinding(env, "resources", context.resources);
  else env.registerVariable("resources", "map");

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
  if (moduleSchema) registerBinding(env, "module", { ...moduleSchema, additionalProperties: false });
  else env.registerVariable("module", "map");

  for (const [name, schema] of Object.entries(context)) {
    if (KERNEL_GLOBALS_REGISTERED.has(name) || env.hasVariable(name) || !isSchemaNode(schema)) continue;
    // A step body's `steps` is the closed record of its step names.
    if (name === "steps" && isStepRecord(schema)) {
      registerBinding(env, name, stepRecordSchema(schema));
    } else registerBinding(env, name, schema);
  }

  return env;
}

/** The globals registered from the module above, never from the context's
 *  own copy of them. */
const KERNEL_GLOBALS_REGISTERED: ReadonlySet<string> = new Set(["variables", "secrets", "ports", "resources", "module"]);

const isSchemaNode = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `name` typed from `schema` to full depth, through the environment's resolver. */
function registerBinding(env: CelEnvironment, name: string, schema: Record<string, any>): void {
  recordHandedSchema(env, name, schema);
  env.registerVariable(name, { schema });
}

/** CEL environment for a parameter scope (`x-telo-context-parameters-from`): the
 *  catalog plus the scope's own bindings, and none of the kernel globals — so a
 *  read of `variables` / `resources` / … is an unknown identifier rather than a
 *  read of state the expression's arguments do not carry. Module calls stay
 *  reachable: they resolve on the parsed tree, not through a variable. */
export function buildParameterCelEnvironment(
  baseEnv: CelEnvironment,
  contextSchema: Record<string, any> | null,
  resolver?: SchemaTypeResolver,
): CelEnvironment {
  const env = baseEnv.clone({ resolveSchemaType: resolver ?? celSchemaResolver(baseEnv, undefined) });
  for (const [name, propSchema] of Object.entries(
    (contextSchema?.properties ?? {}) as Record<string, any>,
  )) {
    if (isSchemaNode(propSchema)) registerBinding(env, name, propSchema);
    else env.registerVariable(name, "dyn");
  }
  return env;
}

/**
 * What a checker rejection of an expression reading a brand should add: the
 * operations the base environment registers for it. A brand is a type of its own,
 * so an operator its base accepts (`+` on a string) finds no overload, and the
 * checker's wording says only that. The brand comes from the engine's checked
 * `readCheckedTypes`, never from the checker's wording or a printed type.
 */
export function valueBrandHint(readTypes: readonly CelType[] | undefined): string {
  // A brand is a named type: its own name says which, read from the type rather than its text.
  const brand = readTypes
    ?.map((type) => (type.kind === "nominal" ? type.name : undefined))
    .find((name) => name !== undefined && VALUE_BRAND_BASE[name] !== undefined);
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
      const properties: Record<string, any> = {};
      // An entry that may be absent (`default: null`) is a value or null.
      for (const [k, v] of entries) {
        const entry = v as Record<string, any>;
        properties[k] = admitsAbsence(entry) ? { anyOf: [entry, { type: "null" }] } : entry;
      }
      registerBinding(env, name, { type: "object", properties, additionalProperties: false });
      return;
    }
  }
  env.registerVariable(name, "map");
}

/** The bindings an import's `variables:` / `secrets:` name and withhold:
 *  those inputs are configuration, evaluated before any resource exists. */
export const IMPORT_INPUT_WITHHELD = {
  type: "object",
  properties: Object.fromEntries(
    ["resources", "ports"].map((name) => [
      name,
      {
        [CONTEXT_WITHHELD]:
          "an import's variables and secrets are configuration, evaluated before any resource exists; pass the value through a variable of the importing module",
      },
    ]),
  ),
} as const satisfies Record<string, any>;

export const IMPORT_INPUT_WITHHELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(IMPORT_INPUT_WITHHELD.properties),
);

/** CEL environment for the `variables:`/`secrets:` expressions on a `Telo.Import`.
 *
 *  Import inputs are a config-only contract: their expressions are evaluated
 *  against the IMPORTING module's `variables`/`secrets`, never the import's own
 *  values map nor the imported child's. `resources` and `ports` are withheld
 *  bindings ({@link IMPORT_INPUT_WITHHELD}): typed `dyn`, every read of either
 *  is refused by the withheld-read check alone. */
export function buildImportInputCelEnvironment(
  baseEnv: CelEnvironment,
  moduleManifest: ResourceManifest | undefined,
  resolver?: SchemaTypeResolver,
): CelEnvironment {
  const env = baseEnv.clone({ resolveSchemaType: resolver ?? celSchemaResolver(baseEnv, undefined) });
  const mod = moduleManifest as Record<string, unknown> | undefined;
  registerConfigNamespace(env, moduleInputBlock(mod, "variables"), "variables");
  registerConfigNamespace(env, moduleInputBlock(mod, "secrets"), "secrets");
  for (const name of IMPORT_INPUT_WITHHELD_NAMES) env.registerVariable(name, "dyn");
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
