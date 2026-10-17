/**
 * The derivation marker a `sdk/builtins` source entry writes in place of a list
 * the capability roster determines — `{ "$roster": "declarable" | "throwsAllowed" }`.
 *
 * `scripts/render-builtin-vocabulary.mjs` is the one place that replaces it. An
 * entry read here is the DERIVED entry, so a marker that survived means the
 * derivation did not run over it — read as a value it would silently mean "no
 * capability is legal". Refused instead.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

const ROSTER_MARKER = "$roster";

/** Throw when `node` still holds a derivation marker anywhere beneath it. */
export function refuseRosterMarkers(node: unknown, where: string, path = ""): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => refuseRosterMarkers(item, where, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === ROSTER_MARKER) {
      throw new Error(
        `${where}: '${ROSTER_MARKER}' marker left underived at '${path || "/"}'. The built-in ` +
          `entries are derived by scripts/render-builtin-vocabulary.mjs — run it (the root and ` +
          `the analyzer's \`prepare\` do).`,
      );
    }
    refuseRosterMarkers(value, where, path ? `${path}.${key}` : key);
  }
}
