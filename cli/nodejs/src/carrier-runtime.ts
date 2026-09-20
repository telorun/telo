/**
 * The Node runtime every `telo` binary carries — one statement of it, read by
 * both halves that need it.
 *
 * The **build** injects this runtime (`scripts/build-standalone.mjs` downloads
 * it per target), and **`telo package`** warms an application's native layers
 * for the ABI it reports. Those two must agree or the packaged app cannot open
 * the addons that travel inside it, and they cannot agree by coincidence: the
 * build script and the command run in different distributions — an npm-installed
 * CLI has no baked values at all, and its own `process.versions.modules` is the
 * ABI of whatever Node the operator happens to be running, not of the carrier it
 * is about to download.
 *
 * Every bump is checked against all seven targets, because the set a version
 * publishes is not uniform: 24.11.1 has no musl build. The ABI moves with the
 * version and only with it — a Node major is one ABI — and the build asserts the
 * pair wherever it can see the runtime it is injecting.
 */

export const CARRIER_NODE_VERSION = "24.21.0";

/** `process.versions.modules` of {@link CARRIER_NODE_VERSION}: the value a
 *  `native:` selector spells as `abi=node-<n>`. */
export const CARRIER_NODE_ABI = "137";
