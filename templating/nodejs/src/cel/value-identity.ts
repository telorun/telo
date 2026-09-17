import { Environment } from "@marcbachmann/cel-js";
import { Duration, UnsignedInt } from "@telorun/sdk";

/** The classes the CEL value domain is typed by. */
export interface CelValueClasses {
  readonly Duration: abstract new (...args: never[]) => unknown;
  readonly UnsignedInt: abstract new (...args: never[]) => unknown;
}

/**
 * Refuse to run with a CEL engine whose values are not the SDK's.
 *
 * cel-js dispatches by constructor, so a second installed copy of it gives the
 * engine a `Duration` / `UnsignedInt` no controller can construct: every value a
 * controller builds from `@telorun/sdk` would fail `+`, `type()` and every
 * overload, at the first expression that meets one. Checked once, where the
 * engine is loaded, so the cause is named before anything evaluates.
 */
export function assertCelValueIdentity(classes: CelValueClasses): void {
  const probe = new Environment();
  const duration = probe.evaluate("duration('1s')");
  const uint = probe.evaluate("1u");
  if (duration instanceof classes.Duration && uint instanceof classes.UnsignedInt) return;
  throw new Error(
    "@telorun/templating's CEL engine is a different copy of @marcbachmann/cel-js than the one " +
      "@telorun/sdk exports Duration and UnsignedInt from, so a duration or uint a controller " +
      "builds would be rejected by every CEL expression. Two copies of @marcbachmann/cel-js are " +
      "installed: every Telo package pins the same exact version, so deduplicate the install " +
      "(`pnpm dedupe` / `npm dedupe`) until one remains.",
  );
}

/** The SDK's classes — the identity every Telo package and controller shares. */
export const SDK_CEL_VALUE_CLASSES: CelValueClasses = { Duration, UnsignedInt };
