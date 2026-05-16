import { Static, Type } from "@sinclair/typebox";
import {
  ControllerContext,
  Invocable,
  isInvokeError,
  KindRef,
  Ref,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";

const DirectReturnEntry = Type.Object({
  when: Type.Optional(Type.Boolean()),
  body: Type.Optional(Type.Unknown()),
});
type DirectReturnEntry = Static<typeof DirectReturnEntry>;

const DirectCatchEntry = Type.Object({
  code: Type.Optional(Type.String()),
  when: Type.Optional(Type.Boolean()),
  body: Type.Optional(Type.Unknown()),
});
type DirectCatchEntry = Static<typeof DirectCatchEntry>;

const DirectManifest = Type.Object({
  handler: Type.Unsafe<KindRef<Invocable>>(Ref("telo#Invocable")),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any())),
  returns: Type.Optional(Type.Array(DirectReturnEntry)),
  catches: Type.Optional(Type.Array(DirectCatchEntry)),
});
type DirectManifest = Static<typeof DirectManifest>;

export async function register(_ctx: ControllerContext): Promise<void> {}

/**
 * Lambda.Direct — pure dispatch target invoked by a Lambda.Function. No event
 * classification of its own (the Function does that). On invoke:
 *
 *   1. Expand `inputs:` CEL with `{ event, context }` as the evaluation context.
 *   2. Call `handler.invoke(inputs)`.
 *   3. On success: walk `returns[]`, return the first entry whose `when:`
 *      evaluates truthy (or is omitted) — its `body` (CEL-expanded) is the
 *      function's return value. If `returns:` is omitted, return the handler's
 *      result verbatim.
 *   4. On `InvokeError`: walk `catches[]`, return the first entry whose `code`
 *      matches and `when:` is truthy. If none match, re-throw — the Function's
 *      poll loop POSTs the error to AWS Runtime API and the SDK caller sees a
 *      failed invocation.
 */
export class LambdaDirect implements ResourceInstance {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly manifest: DirectManifest,
    private readonly handlerRef: { kind: string; name: string } | null,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: { event: unknown; context: unknown }): Promise<unknown> {
    const handler = this.manifest.handler as unknown as ResourceInstance | undefined;
    if (!handler || !this.handlerRef) {
      throw new Error("Lambda.Direct: no handler resolved");
    }

    const invocationContext = { event: input.event, context: input.context };
    const resolvedInputs = this.manifest.inputs
      ? ((this.ctx.moduleContext.expandWith(this.manifest.inputs, invocationContext) as
          | Record<string, unknown>
          | undefined) ?? {})
      : invocationContext;

    let handlerResult: unknown;
    try {
      handlerResult = await this.ctx.invokeResolved(
        this.handlerRef.kind,
        this.handlerRef.name,
        handler,
        resolvedInputs,
      );
    } catch (err) {
      if (!isInvokeError(err)) throw err;
      const errorContext: Record<string, unknown> = {
        event: input.event,
        context: input.context,
        error: { code: err.code, message: err.message, data: err.data },
      };
      const matched = this.matchEntry(this.manifest.catches ?? [], errorContext, err.code);
      if (!matched) throw err;
      return matched.body === undefined
        ? null
        : this.ctx.moduleContext.expandWith(matched.body, errorContext);
    }

    if (!this.manifest.returns || this.manifest.returns.length === 0) {
      return handlerResult;
    }
    const returnContext: Record<string, unknown> = {
      event: input.event,
      context: input.context,
      result: handlerResult,
    };
    const matched = this.matchEntry(this.manifest.returns, returnContext);
    if (!matched) return null;
    return matched.body === undefined
      ? null
      : this.ctx.moduleContext.expandWith(matched.body, returnContext);
  }

  /** First entry whose `when:` expands to strictly `true` wins. Entries without
   *  `when:` are catch-alls — kept as fallback so explicit matches earlier in
   *  the list always beat the catch-all regardless of order. For catches, the
   *  optional `code` constrains matching to the thrown InvokeError's code.
   *
   *  `when === undefined` distinguishes "no when field" from a literal
   *  `when: false`, same precaution as the http-dispatch matcher. */
  private matchEntry<T extends { when?: unknown; code?: string }>(
    entries: T[],
    celCtx: Record<string, unknown>,
    errorCode?: string,
  ): T | undefined {
    let fallback: T | undefined;
    for (const entry of entries) {
      if (errorCode !== undefined && entry.code !== undefined && entry.code !== errorCode) {
        continue;
      }
      if (entry.when === undefined) {
        fallback ??= entry;
        continue;
      }
      if (this.ctx.moduleContext.expandWith(entry.when, celCtx) === true) return entry;
    }
    return fallback;
  }
}

export async function create(
  resource: any,
  ctx: ResourceContext,
): Promise<LambdaDirect> {
  ctx.validateSchema(resource, DirectManifest);
  let handlerRef: { kind: string; name: string } | null = null;
  const h = resource.handler;
  if (h && typeof h === "object") {
    handlerRef = ctx.resolveChildren(h);
  } else if (typeof h === "string") {
    handlerRef = { kind: "", name: h };
  }
  return new LambdaDirect(ctx, resource as DirectManifest, handlerRef);
}
