import { durationMs, RuntimeError } from "@telorun/sdk";
import { PREFIX_PATTERN } from "./key-format.js";
import type { KeySourceSettings } from "./store-contract.js";

/**
 * Reads a source's configuration once, at creation: the prefix, the closed
 * scope vocabulary and, for a store, `maxLifetime` as milliseconds. A backend
 * calls this from its own `create()` and hands the result from `settings()`.
 */
export function keySourceSettingsOf(
  resource: { prefix: string; scopes: readonly string[]; maxLifetime?: unknown },
  describe: string,
): KeySourceSettings {
  if (!PREFIX_PATTERN.test(resource.prefix)) {
    throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: 'prefix' must match ${PREFIX_PATTERN}.`);
  }
  let maxLifetimeMs: number | null = null;
  if (resource.maxLifetime !== undefined && resource.maxLifetime !== null) {
    const ms = durationMs(resource.maxLifetime);
    if (ms === undefined || ms <= 0) {
      throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: 'maxLifetime' must be a positive duration.`);
    }
    maxLifetimeMs = ms;
  }
  return { prefix: resource.prefix, scopes: [...resource.scopes], maxLifetimeMs };
}
