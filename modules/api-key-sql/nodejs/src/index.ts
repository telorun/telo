// Controller entry point. The `Store` kind selects this by PURL fragment; an
// engine module re-exports `Store` from this specifier rather than inlining it,
// so the store-name registry is one module scope across engines. Nothing else
// is exported: the table layout and the statements are internal.
export * as Store from "./store.js";
