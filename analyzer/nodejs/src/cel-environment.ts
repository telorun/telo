import { Environment } from "@marcbachmann/cel-js";
import type { ResourceManifest } from "@telorun/sdk";
import { jsonSchemaToCelType, VALUE_BRAND_BASE } from "./schema-compat.js";

/** Transport protocol on a `ports` entry → the nominal CEL brand its resolved
 *  value carries. Mirrors the `protocol` enum in the Application schema. */
const PORT_PROTOCOL_BRAND: Record<string, string> = {
  tcp: "TcpPort",
  udp: "UdpPort",
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

    // Build typed ObjectSchema from manifest.variables if it looks like a schema map
    const vars = (manifest as Record<string, unknown>).variables;
    if (vars !== null && typeof vars === "object" && !Array.isArray(vars)) {
      const entries = Object.entries(vars as Record<string, unknown>).filter(
        ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v),
      );
      if (entries.length > 0) {
        const schema: Record<string, string> = {};
        for (const [k, v] of entries) {
          schema[k] = jsonSchemaToCelType(v as Record<string, any>);
        }
        (env as any).registerVariable({ name: "variables", schema });
      } else {
        env.registerVariable("variables", "map");
      }
    } else {
      env.registerVariable("variables", "map");
    }

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

    env.registerVariable("secrets", "map");
    env.registerVariable("resources", "map");

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
  return env;
}
