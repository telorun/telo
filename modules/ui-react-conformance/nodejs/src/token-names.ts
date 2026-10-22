// Loaded on the main thread only: `@telorun/ui`'s bundle evaluates the SDK, and
// a worker has no kernel for it to resolve against. The worker is handed the
// names in its job.
let names: Promise<readonly string[]> | undefined;

/** The closed design token names, as `ui` exports them. */
export const loadTokenNames = (): Promise<readonly string[]> => (names ??= import("@telorun/ui").then((ui) => ui.DESIGN_TOKENS));
