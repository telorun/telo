/**
 * The sink contract now lives in `@telorun/sdk` — §10.2 keeps the sink set open
 * to the ecosystem, so a third-party sink module implements it as an ordinary
 * module author rather than importing a kernel-internal type. Re-exported here
 * so the kernel's own imports keep one spelling.
 */
export {
  BLOCK_UNSUPPORTED,
  blockUnsupportedMessage,
  DEFAULT_BUFFER_POLICY,
} from "@telorun/sdk";
export type {
  DropCause,
  LoggingHost,
  LogSinkInstance,
  OnFull,
  SinkBufferPolicy,
} from "@telorun/sdk";
