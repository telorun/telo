export * from "./contract.js";
export * from "./backend.js";
export * from "./config.js";
export * from "./server.js";
// `./container-config.js` is deliberately NOT re-exported here: it is the
// vocabulary of a backend that runs container IMAGES, and the neutral entry
// point is what `telo runner` links. Container backends import it from
// `@telorun/runner-core/container`.
export {
  BaseImageCatalog,
  filterTags,
  parseDockerHubRef,
  type TagFilter,
  type BaseImageCatalogOptions,
} from "./base-image-catalog.js";

export {
  SessionRegistry,
  SessionEvictedError,
  UnknownAppError,
  type AppChannel,
  type AppRunState,
  type RunAttribution,
  type SessionEntry,
  type RegistryDeps,
} from "./session/registry.js";
export {
  SessionLifecycle,
  STOP_GRACE_MS,
  type CreateArgs,
  type CreateOutcome,
  type RunArgs,
  type SessionLifecycleDeps,
} from "./session/session-lifecycle.js";
export { SessionRefusal } from "./session/session-refusal.js";
export {
  callerResolver,
  mintResumeSecret,
  ownsSession,
  resumeSecretHash,
  type Caller,
  type CallerResolver,
  type CallerResolverOptions,
  type CallerResult,
  type CredentialRefusal,
} from "./session/session-credentials.js";
export { IoTickets } from "./session/io-tickets.js";
export {
  IdentityVerifier,
  type IdentityRequest,
  type IdentityVerifierDeps,
} from "./identity/identity-verifier.js";
export {
  IdentityProviderUnavailable,
  IdentityRefusal,
  type IdentityErrorCode,
} from "./identity/identity-refusal.js";
export {
  DPOP_SIGNING_ALGS,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from "./identity/protected-resource-metadata.js";
export {
  SESSION_STORE_SCHEMA_VERSION,
  STORED_SESSION_STATUSES,
  SessionStoreSchemaError,
  type ChangeOwnerResult,
  type CreateSessionResult,
  type SessionOwner,
  type SessionRecord,
  type SessionRecordUpdate,
  type SessionStore,
  type StoredSessionApp,
  type StoredSessionPort,
  type StoredSessionStatus,
} from "./session-store/session-store.js";
export {
  SqliteSessionStore,
  SQLITE_SESSION_STORE_FILENAME,
} from "./session-store/sqlite-session-store.js";
export {
  PostgresSessionStore,
  type PostgresSessionStoreOptions,
} from "./session-store/postgres-session-store.js";
export {
  openSessionStore,
  type OpenSessionStoreOptions,
} from "./session-store/open-session-store.js";
export {
  SESSION_CONTAINER_LABEL,
  SessionContainerFieldRefused,
  SessionContainerNotFound,
  type SessionContainerEngine,
  type SessionContainerOutput,
  type SessionContainerSpec,
  type SessionContainerState,
} from "./session-containers/session-container-engine.js";
export {
  ENGINE_TOKEN_ENV,
  ENGINE_URL_ENV,
  SessionContainers,
} from "./session-containers/session-containers.js";
export { RunProjection } from "./debug/run-projection.js";
export {
  portKey,
  portsResolvedFrom,
  PORTS_RESOLVED_EVENT,
} from "./debug/ports-resolved.js";
export { EventRingBuffer, type BufferedEvent } from "./session/ring-buffer.js";
export { ByteRingBuffer, type BufferedBytes } from "./session/byte-ring-buffer.js";
export { normalizeBundlePath, validateSessionId, BundlePathError } from "./session/bundle-path.js";
export { WorkspaceClient } from "./session/workspace-client.js";
export {
  SupervisorClient,
  SupervisorRunFailed,
  SupervisorTerminated,
  type SupervisorClientOptions,
  type SupervisorListener,
  type SupervisorRunEnding,
  type SupervisorTermination,
} from "./supervisor/supervisor-client.js";
export {
  SUPERVISOR_CLOSE,
  SUPERVISOR_GENERATION,
  SUPERVISOR_PATH,
  SupervisorGenerationMismatch,
  SupervisorProtocolError,
  decodeOutputFrame,
  decodeSupervisorMessage,
  encodeRunnerMessage,
  type OutputFrame,
  type RunnerMessage,
  type SupervisorHello,
  type SupervisorMessage,
} from "./supervisor/supervisor-protocol.js";
export {
  SupervisedApp,
  isGenerationMismatch,
  type SupervisedAppAddress,
  type SupervisedAppEvents,
} from "./supervisor/supervised-app.js";
export {
  workspaceAppManifest,
  WORKSPACE_APP_FILENAME,
  WORKSPACE_EXCLUDED_DIRECTORIES,
} from "./session/workspace-app.js";
export {
  workspaceMarkerWrite,
  WORKSPACE_MARKER_CONTENTS,
  WORKSPACE_MARKER_FILENAME,
} from "./session/workspace-marker.js";
export { streamSessionEvents, type SseStreamArgs } from "./sse/channel.js";
export { healthRoute } from "./routes/health.js";
export { capabilitiesRoute } from "./routes/capabilities.js";
export { probeRoute, type ProbeRouteDeps } from "./routes/probe.js";
export { sessionsRoute, type ConfigGate, type SessionsRouteDeps } from "./routes/sessions.js";
export { ioRoute, type IoRouteDeps } from "./routes/io.js";
export { relayDebugStream, type DebugRelayOptions } from "./debug/relay.js";
export {
  watchReachability,
  type WatchReachabilityOptions,
} from "./reachability.js";
export { abortableDelay } from "./abortable-delay.js";
export type { DebugFrame, DebugEvent, DebugLog } from "@telorun/debug-wire";
