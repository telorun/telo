// For a backend: the store contract the operations call, the guards they
// recognise a store by, and what a backend needs to answer it — its settings,
// the envelope generation and body helpers. Importing any of it is optional: a
// store is recognised by its methods, so a backend importing nothing from here
// is still a store.
export type {
  AddressableQueueStore,
  CancelOutcome,
  ClaimedMessage,
  ClaimOutcome,
  ClaimRequest,
  EnqueueOutcome,
  EnqueueRequest,
  ListOutcome,
  ListRequest,
  MessageState,
  QueueError,
  QueueSettings,
  QueueStats,
  QueueStore,
  ReleaseRequest,
  RenewOutcome,
  RequeueOutcome,
  SettleOutcome,
  StoredMessage,
  StoredMessageAbsent,
  StoredMessageFound,
} from "./queue-store-contract.js";
export { isAddressableQueueStore, isQueueStore } from "./queue-store-contract.js";
export { DEFAULT_MAX_MESSAGE_BYTES, queueSettingsOf } from "./queue-settings.js";
export {
  bodyBytes,
  bodyDigest,
  encodeMessageBody,
  parseMessageBody,
  QUEUE_ENVELOPE_GENERATION,
  sameBody,
} from "./message-envelope.js";
export { mintMessageId } from "./message-id.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and one module
// scope; a backend module re-exports them under its own kinds.
export * as Enqueue from "./enqueue-controller.js";
export * as EnqueueMany from "./enqueue-many-controller.js";
export * as Worker from "./worker-controller.js";
export * as Stats from "./stats-controller.js";
export * as Status from "./status-controller.js";
export * as List from "./list-controller.js";
export * as Cancel from "./cancel-controller.js";
export * as Requeue from "./requeue-controller.js";
