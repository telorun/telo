/**
 * The one CEL form that carries a REFERENCE across a template boundary.
 *
 * A source that is exactly a `self.<path>` member access is resolved by direct
 * navigation, so a live resource instance held by a ref slot reaches the body
 * untouched. Any other expression is evaluated by CEL, whose values are data:
 * a ref inside one either fails to evaluate (CEL rejects the instance) or
 * arrives as the resource's published reading — never as a reference. The
 * kernel navigates on this pattern and the analyzer refuses everything else at
 * a reference slot, so both halves read it from here.
 */
export const SELF_PATH = /^self((?:\.[A-Za-z_$][\w$]*)+)$/;

/** Whether a CEL source forwards `self.<path>` verbatim. */
export function isSelfForward(source: string): boolean {
  return SELF_PATH.test(source.trim());
}
