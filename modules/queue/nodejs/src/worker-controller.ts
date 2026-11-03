import {
  durationMs,
  resolveInvocableDispatcher,
  retryAfterMs,
  type InvokeContext,
  type InvokeStepRetry,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { MessageReader } from "./queue-operation.js";
import { isQueueStore, type QueueError } from "./queue-store-contract.js";
import { durationOfMs, WorkerLoop, type Delivery, type WorkerHost, type WorkerPolicy } from "./worker-loop.js";

/** A lease when `lease` is omitted, and the grace when `shutdownGrace` is: the
 *  documented defaults, filled here because a schema default at a duration
 *  slot is plain JSON nothing decodes. */
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

interface WorkerResource {
  kind?: string;
  metadata: { name: string; module?: string };
  queue?: unknown;
  invoke?: unknown;
  inputs?: Record<string, unknown>;
  concurrency?: number | bigint;
  lease?: unknown;
  timeout?: unknown;
  shutdownGrace?: unknown;
  retry?: InvokeStepRetry;
  onDead?: { invoke?: unknown; inputs?: Record<string, unknown> };
}

/**
 * Queue.Worker — a Service: `init()` reads its configuration and touches
 * nothing; `run()` takes a kernel hold and starts the delivery loop, and
 * returns what stops it — claiming ends, in-flight deliveries get
 * `shutdownGrace` to finish and are then cancelled and handed back.
 */
class QueueWorker implements ResourceInstance {
  private readonly label: string;
  private readonly policy: WorkerPolicy;

  constructor(
    private readonly resource: WorkerResource,
    private readonly ctx: ResourceContext,
  ) {
    this.label = `Queue.Worker "${resource.metadata.name}"`;
    const leaseMs = this.durationField("lease", DEFAULT_LEASE_MS);
    this.policy = {
      concurrency: Number(resource.concurrency ?? 1),
      lease: durationOfMs(leaseMs),
      leaseMs,
      timeoutMs: this.durationField("timeout"),
      shutdownGraceMs: this.durationField("shutdownGrace", DEFAULT_SHUTDOWN_GRACE_MS),
      retry: { ...resource.retry, attempts: Number(resource.retry?.attempts ?? 0) },
    };
  }

  run() {
    return this.ctx
      .effect("kernel hold", async () => ({
        result: undefined,
        inverse: this.ctx.acquireHold(`queue worker ${this.resource.metadata.name}`),
      }))
      .effect("delivery loop", async () => {
        const loop = new WorkerLoop(this.label, this.policy, this.host());
        loop.start();
        return { result: undefined, inverse: () => loop.stop() };
      });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }

  private host(): WorkerHost {
    const ctx = this.ctx;
    const resource = this.resource;
    const store = ctx.resolveRef(resource.queue, isQueueStore, () => `${this.label}: 'queue'`, "Queue.Queue");
    const reader = new MessageReader(store.settings(), ctx);
    const handler = resolveInvocableDispatcher(resource.invoke, ctx, () => this.label);
    const onDead = resource.onDead?.invoke
      ? resolveInvocableDispatcher(resource.onDead.invoke, ctx, () => `${this.label}: 'onDead'`)
      : undefined;
    const ref = { kind: resource.kind ?? "Queue.Worker", name: resource.metadata.name };
    // Both handlers run inside the zone the `invoke` slot declares; the entry a
    // zone mints names this resource and nothing about the slot, so the
    // dead-letter handler's zone is the same one its own annotation declares.
    const inZone = (dispatch: typeof handler, inputs: Record<string, unknown>, invokeCtx: InvokeContext) =>
      ctx.withZone("invoke", (zoneCtx) => dispatch(inputs, zoneCtx), invokeCtx);
    return {
      store,
      log: ctx.log,
      read: (message) => reader.read(message.body, message.generation),
      createCancellationSource: () => ctx.createCancellationSource(),
      rootContext: (cancellation) => ctx.rootContext(cancellation ? { cancellation } : undefined),
      openSpan: (message) =>
        ctx.openSpan(ctx.rootContext(), {
          ref,
          label: `${resource.metadata.name} deliver`,
          attributes: {
            "telo.queue.message.id": message.id,
            "telo.queue.delivery.attempt": message.attempt,
          },
          ...(message.traceparent === undefined
            ? {}
            : {
                inbound: {
                  traceparent: message.traceparent,
                  ...(message.tracestate === undefined ? {} : { tracestate: message.tracestate }),
                },
              }),
        }),
      runHandler: (delivery, message, invokeCtx) =>
        inZone(
          handler,
          ctx.expandValue(resource.inputs ?? {}, { message, delivery: celDelivery(delivery) }) ?? {},
          invokeCtx,
        ),
      ...(onDead
        ? {
            runOnDead: (delivery: Delivery, message: unknown, error: QueueError, invokeCtx: InvokeContext) =>
              inZone(
                onDead,
                ctx.expandValue(resource.onDead?.inputs ?? {}, {
                  message,
                  delivery: celDelivery(delivery),
                  error: celError(error),
                }) ?? {},
                invokeCtx,
              ),
          }
        : {}),
      retryAfterMs: (err) =>
        retryAfterMs(this.policy.retry, err, (expression, error) => ctx.expandValue(expression, { error }), {
          describe: this.label,
        }),
      random: Math.random,
    };
  }

  private durationField(field: "lease" | "timeout" | "shutdownGrace", fallback?: number): number {
    const value = this.resource[field];
    if (value === undefined && fallback !== undefined) return fallback;
    const ms = durationMs(value);
    if (ms === undefined) {
      throw new Error(`${this.label}: '${field}' must be a duration or an integer number of milliseconds.`);
    }
    return ms;
  }
}

/** `delivery` as CEL reads it: the attempt an int. */
function celDelivery(delivery: Delivery): Record<string, unknown> {
  return {
    messageId: delivery.messageId,
    attempt: BigInt(delivery.attempt),
    enqueuedAt: delivery.enqueuedAt,
  };
}

function celError(error: QueueError): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    ...(error.data === undefined ? {} : { data: error.data }),
  };
}

export async function create(resource: WorkerResource, ctx: ResourceContext): Promise<QueueWorker> {
  return new QueueWorker(resource, ctx);
}
