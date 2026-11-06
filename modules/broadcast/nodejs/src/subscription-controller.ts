import {
  resolveInvocableDispatcher,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { isBroadcastChannel, type BroadcastChannel } from "./broadcast-channel-contract.js";
import { SubscriptionLoop, type BroadcastFailure, type SubscriptionHost } from "./subscription-loop.js";

interface HookResource {
  invoke?: unknown;
  inputs?: Record<string, unknown>;
}

interface SubscriptionResource {
  kind?: string;
  metadata: { name: string; module?: string };
  channel?: unknown;
  topics?: string[];
  invoke?: unknown;
  inputs?: Record<string, unknown>;
  onGap?: HookResource;
  onError?: HookResource;
  concurrency?: number | bigint;
  buffer?: number | bigint;
}

const DEFAULT_BUFFER = 256;

/**
 * Broadcast.Subscription — a Service: `init()` reads its configuration and
 * touches nothing; `run()` takes a kernel hold and subscribes, and returns what
 * undoes it — the channel stops delivering, what is queued is dropped and what
 * is running is cancelled and awaited.
 */
class BroadcastSubscription implements ResourceInstance {
  private readonly label: string;

  constructor(
    private readonly resource: SubscriptionResource,
    private readonly ctx: ResourceContext,
  ) {
    this.label = `Broadcast.Subscription "${resource.metadata.name}"`;
  }

  run() {
    return this.ctx
      .effect("kernel hold", async () => ({
        result: undefined,
        inverse: this.ctx.acquireHold(`broadcast subscription ${this.resource.metadata.name}`),
      }))
      .effect("subscription", async () => {
        const channel = this.channel();
        const cancellation = this.ctx.createCancellationSource();
        const loop = new SubscriptionLoop(this.label, this.policy(), this.host(channel, cancellation));
        const handle = await channel.subscribe({
          receive: (payload) => loop.receive(payload),
          gap: (reason) => loop.gap(reason),
        });
        return {
          result: undefined,
          inverse: async () => {
            await handle.close();
            cancellation.cancel("broadcast subscription stopped");
            await loop.stop();
          },
        };
      });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }

  private channel(): BroadcastChannel {
    return this.ctx.resolveRef(
      this.resource.channel,
      isBroadcastChannel,
      () => `${this.label}: 'channel'`,
      "Broadcast.Channel",
    );
  }

  private policy() {
    const { topics, concurrency, buffer } = this.resource;
    return {
      ...(topics === undefined ? {} : { topics }),
      concurrency: Number(concurrency ?? 1),
      buffer: Number(buffer ?? DEFAULT_BUFFER),
    };
  }

  private host(
    channel: BroadcastChannel,
    cancellation: ReturnType<ResourceContext["createCancellationSource"]>,
  ): SubscriptionHost {
    const ctx = this.ctx;
    const resource = this.resource;
    const { messageType } = channel.settings();
    const validator = ctx.createSchemaValidator(messageType);
    const ref = { kind: resource.kind ?? "Broadcast.Subscription", name: resource.metadata.name };
    const handler = resolveInvocableDispatcher(resource.invoke, ctx, () => `${this.label}: 'invoke'`);
    const hook = (field: "onGap" | "onError") => {
      const spec = resource[field];
      return spec?.invoke
        ? { dispatch: resolveInvocableDispatcher(spec.invoke, ctx, () => `${this.label}: '${field}'`), spec }
        : undefined;
    };
    const onGap = hook("onGap");
    const onError = hook("onError");
    return {
      log: ctx.log,
      validate: (message) => {
        try {
          const decoded = ctx.readPlainEncoded(message, messageType);
          validator.validate(decoded);
          return { ok: true, message: decoded };
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      },
      openSpan: (label, attributes) =>
        ctx.openSpan(ctx.rootContext({ cancellation }), {
          ref,
          label: `${resource.metadata.name} ${label}`,
          attributes,
        }),
      runHandler: (topic, message, invokeCtx) =>
        handler((ctx.expandValue(resource.inputs ?? {}, { topic, message }) ?? {}) as Record<string, unknown>, invokeCtx),
      ...(onError
        ? {
            runOnError: (failure: BroadcastFailure, topic: string | null, message: unknown, invokeCtx) =>
              onError.dispatch(
                (ctx.expandValue(onError.spec.inputs ?? {}, {
                  error: celFailure(failure),
                  topic,
                  message,
                }) ?? {}) as Record<string, unknown>,
                invokeCtx,
              ),
          }
        : {}),
      ...(onGap
        ? {
            runOnGap: (reason: string, invokeCtx) =>
              onGap.dispatch(
                (ctx.expandValue(onGap.spec.inputs ?? {}, { reason }) ?? {}) as Record<string, unknown>,
                invokeCtx,
              ),
          }
        : {}),
    };
  }
}

function celFailure(failure: BroadcastFailure): Record<string, unknown> {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.data === undefined ? {} : { data: failure.data }),
  };
}

export async function create(
  resource: SubscriptionResource,
  ctx: ResourceContext,
): Promise<BroadcastSubscription> {
  return new BroadcastSubscription(resource, ctx);
}
