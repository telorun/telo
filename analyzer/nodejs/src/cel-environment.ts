import { Environment } from "@marcbachmann/cel-js";
import type { ResourceManifest } from "@telorun/sdk";
import { authoredModuleMetadata, moduleMetadataSchema } from "./module-metadata-scope.js";
import { jsonSchemaToCelType, VALUE_BRAND_BASE } from "./schema-compat.js";

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
  baseEnv: Environment,
  manifest: ResourceManifest,
  extraContextSchema?: Record<string, any> | null,
  // The `ports` namespace is Application-only and lives on the module doc, not
  // on the resource being analyzed. When validating a resource, the caller
  // passes the module manifest here so `${{ ports.X }}` types cross-doc.
  rootModuleManifest?: ResourceManifest,
): Environment {
  try {
    const env = baseEnv.clone();

    // Register nominal value brands (TcpPort/UdpPort/…) on the *clone* so the
    // type-checker can distinguish structurally-identical values. The base env
    // (shared with the kernel runtime) is untouched — a branded value flows as
    // a plain integer at runtime, so only static checking needs these. cel-js
    // auto-generates a field-less wrapper class; no runtime constructor needed.
    for (const brand of Object.keys(VALUE_BRAND_BASE)) {
      (env as any).registerType(brand, { fields: {} });
    }

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
    // showing `${{ secrets.API_KEY }}` — illustrates what a CONSUMER writes, in
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
    // (tcp → TcpPort, udp → UdpPort), so `${{ ports.http }}` carries a nominal
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
        (env as any).registerVariable({ name: "ports", schema });
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
      (env as any).registerVariable({ name: "module", schema });
    } else {
      env.registerVariable("module", "map");
    }

    if (extraContextSchema?.properties) {
      for (const [name, propSchema] of Object.entries(
        extraContextSchema.properties as Record<string, any>,
      )) {
        if (!env.hasVariable(name)) {
          env.registerVariable(name, jsonSchemaToCelType(propSchema as Record<string, any>));
        }
      }
    }

    return env;
  } catch {
    return baseEnv.clone();
  }
}

/**
 * A kind document — whose CEL is written for whoever instantiates the kind, not
 * evaluated in the declaring module's own scope.
 *
 * Its `examples:` show a consumer's route reading `request` and `result`, its
 * `description`s show `${{ secrets.API_KEY }}`, and a rule condition reads the
 * `self` / `referrer` its own evaluator binds. None of those names are in scope
 * where they are WRITTEN, and all of them are correct where they are READ — so
 * every check that asks "is this name in scope here" has to stand down on these
 * documents, or it reports errors nobody can fix without deleting the example.
 */
export function isKindDocument(manifest: ResourceManifest): boolean {
  return manifest.kind === "Telo.Definition" || manifest.kind === "Telo.Abstract";
}

/** Register a `variables`/`secrets` namespace typed from a module doc's schema map
 *  (`{ name: <schema>, … }`), falling back to dyn `map` when absent or untyped. */
function registerConfigNamespace(
  env: Environment,
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
      (env as any).registerVariable({ name, schema });
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
  baseEnv: Environment,
  moduleManifest: ResourceManifest | undefined,
): Environment {
  const env = baseEnv.clone();
  for (const brand of Object.keys(VALUE_BRAND_BASE)) {
    (env as any).registerType(brand, { fields: {} });
  }
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
    (env as any).registerVariable({ name, schema: {} });
  }
  // `module` IS part of it: the importer's own identity is config, and passing
  // its version down to a child is the case the binding exists for.
  const metadata = authoredModuleMetadata(mod?.metadata as Record<string, unknown> | undefined);
  if (Object.keys(metadata).length > 0) {
    const schema: Record<string, string> = {};
    for (const key of Object.keys(metadata)) schema[key] = "dyn";
    (env as any).registerVariable({ name: "module", schema });
  } else {
    env.registerVariable("module", "map");
  }
  return env;
}
