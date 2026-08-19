/**
 * The module's single entry point — one namespace per kind, which is what the
 * controller PURLs' `#fragment`s select out of the one bundle this module ships.
 *
 * One bundle per module is not a packaging preference: a bundle is a module
 * graph, so a shared source file compiled into two bundles is two module scopes,
 * and any state kept beside the instances silently becomes two of them.
 */
export * as idempotent from "./idempotent.js";
export * as sleep from "./sleep.js";
export * as awaitDelivery from "./await-delivery.js";
export * as value from "./value.js";
