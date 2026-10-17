import { isReservedKindPrefix } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";

/**
 * `ERR_KIND_PREFIX_RESERVED` — the runtime half of `KIND_PREFIX_RESERVED`, over
 * the analyzer's one rule (`reserved-kind-prefix.ts`).
 *
 * The loader refuses an import aliased `Telo` / `Self`, or reaching a library of
 * that name, before anything is registered, and the load raises that refusal
 * like every other import failure (`import-load-failure.ts`).
 * {@link refuseReservedKindPrefix} is the guard the sites registering a name as
 * a kind prefix run — the root application's name and an import's alias — for
 * a load whose graph did not pass through it; an imported library's name is
 * judged with the import's target identity (`importFailure`).
 */
export function refuseReservedKindPrefix(name: string | undefined, message: () => string): void {
  if (isReservedKindPrefix(name)) throw new RuntimeError("ERR_KIND_PREFIX_RESERVED", message());
}
