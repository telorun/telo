/**
 * Bare specifiers a controller may import that must resolve to the *kernel's own
 * copy*, so module identity is shared across the kernel/controller boundary
 * (e.g. `Stream`, `InvokeError`). The npm loader pins these as `file:` deps in
 * its install root; the bundle loader maps them via an ESM resolve hook. Single
 * source of truth for both.
 */
export const REALM_COLLAPSE_NAMES: ReadonlyArray<string> = ["@telorun/sdk"];
