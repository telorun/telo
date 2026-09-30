/**
 * Whether a capability is in the `Telo.Executable` lineage — "control can be
 * transferred to this", with call arguments. Read by the slot-acceptance check
 * and by the CEL scope rule (`inputs` exists only where a call's arguments do).
 *
 * Browser-safe: no Node built-ins.
 */
import type { DefinitionRegistry } from "./definition-registry.js";

/** Does this capability name `Telo.Executable` or extend it, transitively?
 *  Derived from the abstract hierarchy at call time, never from a name list. */
export function capabilityExtendsExecutable(capability: string, defs: DefinitionRegistry): boolean {
  let current: string | undefined = capability;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === "Telo.Executable") return true;
    seen.add(current);
    current = defs.resolve(current)?.extends as string | undefined;
  }
  return false;
}
