import type { ResourceContext } from "@telorun/sdk";
import type { ShellHost } from "./shell-host.js";

interface HostRef {
  name: string;
  alias?: string;
}

function isShellHost(value: unknown): value is ShellHost {
  return typeof (value as ShellHost | undefined)?.exec === "function";
}

/**
 * Resolve the `host` field of a Shell operation to a live `Shell.Host`. The
 * value is either the Phase-5-injected instance or — for a cross-module
 * `!ref Alias.host` reached through a nested library — the raw `{name, alias}`
 * ref, which must route through the import's exported scope. Mirrors
 * `resolveSqlConnection`.
 */
export function resolveShellHost(value: ShellHost | HostRef | undefined, ctx: ResourceContext): ShellHost {
  if (!value) {
    throw new Error("Shell: 'host' is required");
  }
  if (isShellHost(value)) {
    return value;
  }

  const ref = value as HostRef;
  if (typeof ref.name !== "string") {
    throw new Error("Shell: invalid host reference");
  }

  if (ref.alias && ref.alias !== "Self") {
    const instance = ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name);
    if (!isShellHost(instance)) {
      throw new Error(
        `Shell: host reference '${ref.alias}.${ref.name}' did not resolve to a Shell.Host instance.`,
      );
    }
    return instance;
  }

  const instance = ctx.moduleContext.getInstance(ref.name);
  if (!isShellHost(instance)) {
    throw new Error(`Shell: host reference '${ref.name}' did not resolve to a Shell.Host instance.`);
  }
  return instance;
}
