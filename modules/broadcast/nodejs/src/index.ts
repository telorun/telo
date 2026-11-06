// For a backend: the channel interface the operations call, the guard they
// recognise a channel by, and what a backend needs to implement it — its
// settings, the payload encoding and the topic grammar. Importing any of it is
// optional: a channel is recognised by its methods, so a backend importing
// nothing from here is still a channel.
export type {
  BroadcastChannel,
  BroadcastListener,
  BroadcastSettings,
  BroadcastSubscriptionHandle,
} from "./broadcast-channel-contract.js";
export { isBroadcastChannel } from "./broadcast-channel-contract.js";
export { broadcastSettingsOf, DEFAULT_MAX_BYTES } from "./broadcast-settings.js";
export {
  decodeBroadcastPayload,
  encodeBroadcastPayload,
  payloadBytes,
  type DecodedPayload,
} from "./broadcast-payload.js";
export { isTopic, isTopicPattern, TOPIC_MAX_BYTES, topicMatches } from "./topic-grammar.js";
export { ERR_BROADCAST_MESSAGE_TOO_LARGE, ERR_BROADCAST_UNAVAILABLE } from "./publish-controller.js";
export { ERR_BROADCAST_MESSAGE_INVALID } from "./subscription-loop.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and one module
// scope; a backend module re-exports them under its own kinds.
export * as MemoryChannel from "./memory-channel-controller.js";
export * as Publish from "./publish-controller.js";
export * as Subscription from "./subscription-controller.js";
