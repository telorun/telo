import {
  InvokeError,
  isCancellationError,
  isInvokeError,
  type DataValidator,
  type InvokeContext,
  type KindRef,
  type ResourceContext,
} from "@telorun/sdk";
import {
  isAddressableQueueStore,
  isQueueStore,
  type AddressableQueueStore,
  type QueueError,
  type QueueSettings,
  type QueueStore,
} from "./queue-store-contract.js";
import { parseMessageBody, QUEUE_ENVELOPE_GENERATION } from "./message-envelope.js";

export interface OperationResource {
  kind?: string;
  metadata: { name: string; module?: string };
  queue?: QueueStore | KindRef<QueueStore>;
}

export const ERR_QUEUE_UNAVAILABLE = "ERR_QUEUE_UNAVAILABLE";
export const ERR_QUEUE_MESSAGE_INVALID = "ERR_QUEUE_MESSAGE_INVALID";
/** Terminal: the queue's storage answered in a way its contract rules out — a
 *  store raises it for a broken invariant of its own, an operation for an
 *  answer that is no outcome. Re-issuing the call cannot help. */
export const ERR_QUEUE_STORE_INCONSISTENT = "ERR_QUEUE_STORE_INCONSISTENT";
/** Terminal: a message's group member (the backend's `groupBy`) does not name a
 *  group — it is absent or not a string. Raised by the store at enqueue. */
export const ERR_QUEUE_GROUP_INVALID = "ERR_QUEUE_GROUP_INVALID";

/** The terminal error an operation raises for an answer that is no outcome. */
export function storeInconsistent(describe: string, what: string): InvokeError {
  return new InvokeError(
    ERR_QUEUE_STORE_INCONSISTENT,
    `${describe}: the queue's storage answered ${what}, which its contract rules out; re-issuing ` +
      `the call cannot help.`,
  );
}

/** One operation resource: its label for messages, and the store its `queue`
 *  slot names — resolved per call, so creation orders against nothing. */
export class BoundQueueOperation {
  readonly describe: string;

  constructor(
    kind: string,
    readonly resource: OperationResource,
    readonly ctx: ResourceContext,
  ) {
    this.describe = `${kind} "${resource.metadata.name}"`;
  }

  get store(): QueueStore {
    return this.ctx.resolveRef(
      this.resource.queue,
      isQueueStore,
      () => `${this.describe}: 'queue'`,
      "Queue.Queue",
    );
  }

  get addressableStore(): AddressableQueueStore {
    return this.ctx.resolveRef(
      this.resource.queue,
      isAddressableQueueStore,
      () => `${this.describe}: 'queue'`,
      "Queue.AddressableQueue",
    );
  }

  /** Run one store call. A cancellation and a Telo-coded error — a store's
   *  terminal `ERR_QUEUE_STORE_INCONSISTENT` / `ERR_QUEUE_GROUP_INVALID` above
   *  all — pass through as they are; any other failure is the storage's,
   *  raised as the retryable `ERR_QUEUE_UNAVAILABLE` with the failure as its
   *  cause. */
  async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      throw storeFailure(this.describe, err);
    }
  }
}

export function storeFailure(describe: string, err: unknown): unknown {
  if (isCancellationError(err) || isInvokeError(err) || isCodedRuntimeError(err)) return err;
  const reason = err instanceof Error ? err.message : String(err);
  return new InvokeError(
    ERR_QUEUE_UNAVAILABLE,
    `${describe}: the queue's storage failed — ${reason}`,
    undefined,
    { cause: err },
  );
}

function isCodedRuntimeError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "RuntimeError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/** What a stored body reads as against the queue's message type. */
export type DecodedMessage =
  | { readonly ok: true; readonly message: unknown }
  | { readonly ok: false; readonly error: QueueError };

/**
 * Reads stored bodies back into messages: the envelope generation, the JSON,
 * every plain-encoded value decoded into its instance, and the result held to
 * the message type. One reader per queue; its validator is compiled once.
 */
export class MessageReader {
  private validator: DataValidator | undefined;

  constructor(
    private readonly settings: QueueSettings,
    private readonly ctx: Pick<ResourceContext, "readPlainEncoded" | "createSchemaValidator">,
  ) {}

  read(body: string, generation: number): DecodedMessage {
    if (generation !== QUEUE_ENVELOPE_GENERATION) {
      return invalid(
        `it was stored under envelope generation ${generation}, which this runtime does not read`,
      );
    }
    let decoded: unknown;
    try {
      decoded = this.ctx.readPlainEncoded(parseMessageBody(body), this.settings.messageType);
      this.validator ??= this.ctx.createSchemaValidator(this.settings.messageType);
      this.validator.validate(decoded);
    } catch (err) {
      return invalid(err instanceof Error ? err.message : String(err));
    }
    return { ok: true, message: decoded };
  }
}

function invalid(reason: string): DecodedMessage {
  return {
    ok: false,
    error: {
      code: ERR_QUEUE_MESSAGE_INVALID,
      message: `The stored message does not have the queue's message type: ${reason}`,
    },
  };
}

/** The context an operation hands its store: the caller's, unchanged. */
export type StoreCallContext = InvokeContext | undefined;
