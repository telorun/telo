import { Static, Type } from "@sinclair/typebox";
import {
  ControllerContext,
  Invocable,
  KindRef,
  Ref,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";

const SqsManifest = Type.Object({
  queue: Type.Optional(
    Type.Object({
      queueName: Type.Optional(Type.String()),
      queueArn: Type.Optional(Type.String()),
    }),
  ),
  batchSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  partialBatchResponse: Type.Optional(Type.Boolean()),
  handler: Type.Unsafe<KindRef<Invocable>>(Ref("telo#Invocable")),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any())),
});
type SqsManifest = Static<typeof SqsManifest>;

export async function register(_ctx: ControllerContext): Promise<void> {}

interface SqsRecord {
  messageId?: string;
  body?: string;
  attributes?: Record<string, unknown>;
  messageAttributes?: Record<string, unknown>;
  eventSourceARN?: string;
}

interface SqsBatchEvent {
  Records: SqsRecord[];
}

interface SqsBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

/**
 * Lambda.Sqs — SQS queue trigger. One queue, one handler. The Function
 * dispatches the incoming `{Records: [...]}` event here; the handler decides
 * what to do per record.
 *
 * Contract:
 *   - The user's `inputs:` CEL is expanded once per Lambda invocation with
 *     `{event, context}` in scope. Typical pattern: `records: !cel "event.Records"`.
 *   - The handler is invoked once per batch (not per record). If the handler
 *     wants per-message granularity it iterates internally; that's by design
 *     and matches AWS's SQS event-source-mapping semantics.
 *   - `partialBatchResponse: true` (default): the handler may return
 *     `{batchItemFailures: [{itemIdentifier: "<msg-id>"}, ...]}` to signal that
 *     only those messages need retry. The controller passes the structure
 *     through to AWS verbatim. Returning anything else (or nothing) signals a
 *     full-batch success.
 *   - `partialBatchResponse: false`: the controller always returns
 *     `{batchItemFailures: []}` on success. Per-message retries are not
 *     available — an unhandled throw is the only retry mechanism.
 *   - An unhandled throw propagates out of `invoke()` to the Function's poll
 *     loop, which posts the error to the AWS Runtime API. AWS treats this as
 *     a full-batch retry.
 */
export class LambdaSqs implements ResourceInstance {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly manifest: SqsManifest,
    private readonly handlerRef: { kind: string; name: string } | null,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: {
    event: SqsBatchEvent;
    context: unknown;
  }): Promise<SqsBatchResponse> {
    const handler = this.manifest.handler as unknown as ResourceInstance | undefined;
    if (!handler || !this.handlerRef) {
      throw new Error("Lambda.Sqs: no handler resolved");
    }

    const invocationContext = { event: input.event, context: input.context };
    const resolvedInputs = this.manifest.inputs
      ? ((this.ctx.moduleContext.expandWith(this.manifest.inputs, invocationContext) as
          | Record<string, unknown>
          | undefined) ?? {})
      : invocationContext;

    const handlerResult = await this.ctx.invokeResolved(
      this.handlerRef.kind,
      this.handlerRef.name,
      handler,
      resolvedInputs,
    );

    const partialBatch = this.manifest.partialBatchResponse !== false;
    if (!partialBatch) return { batchItemFailures: [] };

    // Pass-through: if the handler returned the partial-batch shape, surface
    // it verbatim. Otherwise default to full-batch success — AWS treats
    // `batchItemFailures: []` as "all messages handled."
    if (
      handlerResult &&
      typeof handlerResult === "object" &&
      Array.isArray((handlerResult as { batchItemFailures?: unknown }).batchItemFailures)
    ) {
      const failures = (handlerResult as { batchItemFailures: unknown[] }).batchItemFailures;
      const normalised: Array<{ itemIdentifier: string }> = [];
      for (const f of failures) {
        if (
          f &&
          typeof f === "object" &&
          typeof (f as { itemIdentifier?: unknown }).itemIdentifier === "string"
        ) {
          normalised.push({ itemIdentifier: (f as { itemIdentifier: string }).itemIdentifier });
        }
      }
      return { batchItemFailures: normalised };
    }
    return { batchItemFailures: [] };
  }
}

export async function create(
  resource: any,
  ctx: ResourceContext,
): Promise<LambdaSqs> {
  ctx.validateSchema(resource, SqsManifest);
  let handlerRef: { kind: string; name: string } | null = null;
  const h = resource.handler;
  if (h && typeof h === "object") {
    handlerRef = ctx.resolveChildren(h);
  } else if (typeof h === "string") {
    handlerRef = { kind: "", name: h };
  }
  return new LambdaSqs(ctx, resource as SqsManifest, handlerRef);
}
