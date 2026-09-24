import { RuntimeError } from "@telorun/sdk";
import { celExpressionsOf, walkCelExpressions } from "@telorun/templating";

/** Stored entry for a single context provider */
interface ProviderEntry {
  kind: string;
  name: string;
  module: string;
  /**
   * If defined, only resources whose `"${kind}/${name}"` is in this list may
   * access this provider's context. `undefined` means unrestricted.
   * An empty array means no consumer is allowed.
   */
  grants: string[] | undefined;
  context: Record<string, unknown>;
}

/**
 * Accumulates ContextProvider contributions during the AOT boot initialization
 * multi-pass loop and enforces RBAC visibility rules.
 *
 * Lifecycle:
 *   1. A provider resource is created + init()'d → kernel calls register().
 *   2. Before a consumer resource is created → kernel calls buildContext() to
 *      obtain a per-consumer CEL evaluation context.
 *   3. buildContext() enforces grants and scans the raw manifest for unauthorized
 *      references, throwing ERR_VISIBILITY_DENIED on violations.
 */
export class BootContextRegistry {
  private providers: ProviderEntry[] = [];

  /**
   * Register a new context provider after its init() has completed.
   * Called by the kernel for every resource instance that passes isContextProvider().
   */
  register(
    kind: string,
    name: string,
    module: string,
    grants: string[] | undefined,
    context: Record<string, unknown>,
  ): void {
    this.providers.push({ kind, name, module, grants, context });
  }

  /**
   * Returns true if at least one provider has been registered.
   * Used by the kernel to skip context resolution when there are no providers yet.
   */
  hasProviders(): boolean {
    return this.providers.length > 0;
  }

  /**
   * Build a CEL evaluation context for a specific consumer resource, enforcing
   * RBAC grants.
   *
   * For each registered provider:
   *  - `grants === undefined` → unrestricted, always included.
   *  - `grants` defined and consumer key in grants → included.
   *  - `grants` defined and consumer key NOT in grants:
   *      - Scan the manifest's CEL expressions for any that reference
   *        the provider's namespace prefix (`"${kind}.${name}."`).
   *      - If a reference is found → throw ERR_VISIBILITY_DENIED immediately.
   *      - If no reference → silently exclude the provider from the context.
   *
   * CEL context structure mirrors the kind hierarchy:
   *   kind="Config", name="database"     → { Config: { database: { host, port } } }
   *   kind="MyApp.Secrets", name="vault" → { MyApp: { Secrets: { vault: { ... } } } }
   *
   * @param consumerKind - kind of the resource being initialized (e.g. "MyApp.Api.Server")
   * @param consumerName - name of the resource being initialized (e.g. "api")
   * @param rawManifest  - the unresolved manifest object (used for namespace reference scan)
   */
  buildContext(
    consumerKind: string,
    consumerName: string,
    rawManifest: Record<string, unknown>,
  ): Record<string, unknown> {
    const consumerKey = `${consumerKind}/${consumerName}`;
    const celContext: Record<string, unknown> = {};

    for (const provider of this.providers) {
      const isGranted = provider.grants === undefined || provider.grants.includes(consumerKey);

      if (!isGranted) {
        const namespacePrefix = buildProviderNamespacePrefix(provider.kind, provider.name);
        if (manifestReferencesNamespace(rawManifest, namespacePrefix)) {
          throw new RuntimeError(
            "ERR_VISIBILITY_DENIED",
            `Resource "${consumerKind}/${consumerName}" references context from ` +
              `provider "${provider.kind}/${provider.name}" but is not listed in its grants. ` +
              `Add "${consumerKey}" to the provider's grants field to allow access.`,
          );
        }
        // Not referenced and not granted — silently exclude
        continue;
      }

      mergeProviderIntoContext(celContext, provider.kind, provider.name, provider.context);
    }

    return celContext;
  }
}

/**
 * Build the namespace prefix string that appears inside a CEL expression
 * when a consumer references this provider.
 *
 * The trailing dot ensures we match the start of a property access without
 * false-matching a shared prefix substring:
 *   kind="Config", name="database"    → "Config.database."
 *   kind="MyApp.Secrets", name="vault" → "MyApp.Secrets.vault."
 */
function buildProviderNamespacePrefix(kind: string, name: string): string {
  return `${kind}.${name}.`;
}

/**
 * Whether any CEL expression the manifest holds — a `!cel` value, a hole of a
 * tag with holes — reads through the provider's namespace prefix.
 */
function manifestReferencesNamespace(manifest: unknown, namespacePrefix: string): boolean {
  let found = false;
  walkCelExpressions(manifest, "", (source, _path, engine) => {
    if (!found) found = celExpressionsOf(engine, source).some((x) => x.includes(namespacePrefix));
  });
  return found;
}

/**
 * Place provider.context into the CEL context object under the path
 * defined by the provider's kind segments and name.
 *
 *   kind="Config", name="database":
 *     context.Config = { database: { host, port } }
 *
 *   kind="MyApp.Api", name="server":
 *     context.MyApp = { Api: { server: { ... } } }
 */
function mergeProviderIntoContext(
  celContext: Record<string, unknown>,
  kind: string,
  name: string,
  providerData: Record<string, unknown>,
): void {
  const kindSegments = kind.split(".");
  let cursor = celContext;
  for (const segment of kindSegments) {
    if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[name] = providerData;
}
