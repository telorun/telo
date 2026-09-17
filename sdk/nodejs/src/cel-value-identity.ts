/**
 * The CEL value domain's identity: the classes a CEL `duration` and `uint` are
 * instances of.
 *
 * cel-js types and dispatches by constructor, so a `Duration` built by one copy
 * of the engine is not a duration to another — `+`, `type()` and every overload
 * would reject it. This is the SDK's one runtime dependency, pinned to an exact
 * version, and the only place any Telo package or controller obtains these
 * classes: the SDK is a single scope per process (`REALM_COLLAPSE_NAMES`), so
 * importing them from here is what makes a controller's value and the kernel's
 * engine agree. A timestamp needs no entry — CEL's is the host `Date`.
 */
export { Duration, UnsignedInt } from "@marcbachmann/cel-js/evaluator";
