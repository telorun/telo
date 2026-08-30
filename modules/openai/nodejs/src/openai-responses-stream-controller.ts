/**
 * The streaming half of the responses provider.
 *
 * Its own module because a PURL fragment selects an export carrying `create`,
 * and the two kinds are two contracts. The implementation lives beside the
 * buffered one so the request translation — the drift-prone half — is written
 * once.
 */
export { createStream as create, register } from "./openai-responses-controller.js";
