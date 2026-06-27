import { Static, Type } from "@sinclair/typebox";
import {
  ControllerContext,
  Invocable,
  InvokeContext,
  KindRef,
  Ref,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { CLASSIFIERS, HandlerKindKey } from "./common/classifier.js";
import { pollNext, postError, postResponse } from "./common/runtime-api.js";

const FunctionManifest = Type.Object({
  handlers: Type.Array(Type.Unsafe<KindRef<Invocable>>(Ref("aws/lambda#Handler")), {
    minItems: 1,
  }),
});
type FunctionManifest = Static<typeof FunctionManifest>;

export async function register(_ctx: ControllerContext): Promise<void> {}

/**
 * Lambda.Function — `Telo.Service` that owns the AWS-facing transport for one
 * AWS Lambda artifact (one ARN). The bootstrap calls `kernel.invoke` against
 * this instance per AWS event; the Function classifies the event by shape and
 * dispatches to the matching handler via `ctx.invoke`.
 *
 * Lifecycle (mirrors `Http.Server`):
 *   - `init()` — prepare the classifier table; no outside-world engagement.
 *   - `run()`  — under custom runtimes (`$AWS_LAMBDA_RUNTIME_API` set), start
 *                the poll loop and `acquireHold()` the kernel. Under managed
 *                runtimes, `run()` is never called (the managed bootstrap
 *                stops at `kernel.boot()`) — AWS owns the outer loop.
 *   - `teardown()` — release the hold and stop the poll loop.
 *   - `invoke({event, context})` — called per AWS event by the bootstrap or
 *                                  the poll loop. Classify → dispatch.
 */
export class LambdaFunction implements ResourceInstance {
  private releaseHold: (() => void) | null = null;
  private polling = false;
  /** Aborted by `teardown()` to interrupt the custom-mode poll loop's
   *  in-flight `fetch /next` call — without this, AWS's SIGTERM shutdown
   *  window can elapse before the long-poll returns naturally. */
  private pollAbort: AbortController | null = null;
  /** Map from classified kind key → resolved handler instance (post Phase 5 injection). */
  private readonly handlersByKind = new Map<
    HandlerKindKey,
    { resource: { kind: string; name: string }; instance: ResourceInstance }
  >();

  constructor(
    private readonly ctx: ResourceContext,
    private readonly manifest: FunctionManifest,
    private readonly handlerRefs: Array<{ kind: string; name: string }>,
    private readonly resourceName: string,
  ) {}

  async init(): Promise<void> {
    const seen = new Set<HandlerKindKey>();
    for (let i = 0; i < this.manifest.handlers.length; i++) {
      const ref = this.handlerRefs[i];
      // After Phase 5 injection, `handlers[i]` is the live ResourceInstance.
      const instance = this.manifest.handlers[i] as unknown as ResourceInstance;
      const key = this.classifyHandlerKind(ref.kind);
      if (!key) {
        throw new Error(
          `Lambda.Function: handler '${ref.kind}/${ref.name}' has no classifier entry — ` +
            `not a recognised Lambda.Handler concrete kind`,
        );
      }
      if (seen.has(key)) {
        throw new Error(
          `Lambda.Function: handler kind '${key}' listed more than once — each kind may appear ` +
            `at most once per Function (ambiguous classification)`,
        );
      }
      seen.add(key);
      this.handlersByKind.set(key, { resource: ref, instance });
    }
  }

  async run(): Promise<void> {
    const runtimeApi = this.ctx.env.AWS_LAMBDA_RUNTIME_API;
    this.releaseHold = this.ctx.acquireHold("lambda-function-running");

    // Mode is inferred from the environment: managed runtimes (nodejs24.x) leave
    // $AWS_LAMBDA_RUNTIME_API unset — AWS owns the outer loop and calls the
    // bootstrap-exported handler, so the hold is all we do here. Custom runtimes
    // set it to the Runtime API endpoint we poll below.
    if (!runtimeApi) return;

    this.polling = true;
    this.pollAbort = new AbortController();
    // pollLoop is detached on purpose — run() must return so the kernel's
    // runTargets() can proceed to wait-for-idle. We attach a catch handler so
    // a pre-invocation failure (e.g. boot-time fetch /next throws before the
    // first requestId) surfaces through the kernel lifecycle instead of
    // becoming an unhandled promise rejection. The hold is released so the
    // kernel can drain and exit; teardown() is left to the SIGTERM path.
    void this.pollLoop(runtimeApi).catch((err) => {
      this.polling = false;
      void this.ctx.emitEvent(`${this.resourceName}.PollLoopFailed`, {
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      });
      if (this.releaseHold) {
        this.releaseHold();
        this.releaseHold = null;
      }
    });
  }

  async teardown(): Promise<void> {
    this.polling = false;
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
    if (this.releaseHold) {
      this.releaseHold();
      this.releaseHold = null;
    }
  }

  /** Called per AWS event by the bootstrap (managed) or the poll loop (custom). */
  async invoke(inputs: { event: unknown; context: unknown }): Promise<unknown> {
    const { event, context } = inputs;
    const classified = this.classifyEvent(event);
    if (!classified) {
      throw new Error("Lambda.Function: no handler matched the incoming event shape");
    }
    const entry = this.handlersByKind.get(classified);
    if (!entry) {
      throw new Error(
        `Lambda.Function: event classified as '${classified}' but no handler of that kind is ` +
          `registered on this Function`,
      );
    }
    // Arm cancellation at the AWS deadline so honoring handlers stop before the
    // platform hard-kills the invocation.
    const deadlineMs = (context as { deadlineMs?: number } | undefined)?.deadlineMs;
    const source =
      typeof deadlineMs === "number" ? this.ctx.createCancellationSource() : undefined;
    source?.cancelAt(deadlineMs!);
    try {
      return await this.ctx.invokeResolved(
        entry.resource.kind,
        entry.resource.name,
        entry.instance,
        { event, context },
        source?.context,
      );
    } finally {
      // Release the deadline timer when the handler finishes early.
      source?.dispose();
    }
  }

  private async pollLoop(runtimeApi: string): Promise<void> {
    while (this.polling) {
      let requestId = "";
      try {
        const invocation = await pollNext(runtimeApi, this.pollAbort?.signal);
        requestId = invocation.requestId;
        const result = await this.invoke({
          event: invocation.event,
          context: invocation.context,
        });
        await postResponse(runtimeApi, requestId, result);
      } catch (err) {
        // Teardown-triggered abort surfaces as DOMException("AbortError") from
        // fetch — exit cleanly without posting an error to a requestId we
        // never received.
        if (!this.polling || isAbortError(err)) return;
        if (requestId) {
          await postError(runtimeApi, requestId, err);
        } else {
          // Failure before an invocation was retrieved — the Runtime API has no
          // requestId to attach the error to. Re-throw so the kernel surfaces
          // the boot-time failure rather than spin-looping silently.
          throw err;
        }
      }
    }
  }

  /** Resolves a handler's declared kind to a classifier entry key. Accepts
   *  aliased forms (e.g. "Lambda.HttpApi") and canonical forms (e.g.
   *  "aws/lambda.HttpApi"). */
  private classifyHandlerKind(kind: string): HandlerKindKey | undefined {
    // Strip alias prefix if present (anything ending in ".HttpApi" / ".Sqs" /
    // ".Direct"). The canonical kind keys live in CLASSIFIERS.
    for (const c of CLASSIFIERS) {
      const suffix = c.kind.slice(c.kind.lastIndexOf(".") + 1);
      if (kind === c.kind) return c.kind;
      if (kind.endsWith(`.${suffix}`)) return c.kind;
    }
    return undefined;
  }

  private classifyEvent(event: unknown): HandlerKindKey | undefined {
    for (const c of CLASSIFIERS) {
      // Skip classifier entries for which this Function has no registered
      // handler — otherwise Direct's catch-all would swallow events meant for
      // a Function that only declares HttpApi but receives a non-HTTP event by
      // accident (better to surface "unroutable" than route to the wrong one).
      if (!this.handlersByKind.has(c.kind)) continue;
      if (c.matches(event)) return c.kind;
    }
    return undefined;
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    ((err as { name?: string }).name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR")
  );
}

export async function create(
  resource: any,
  ctx: ResourceContext,
): Promise<LambdaFunction> {
  ctx.validateSchema(resource, FunctionManifest);
  // Capture each handler's {kind, name} before Phase 5 injection replaces the
  // ref with the live ResourceInstance. invokeResolved() needs the kind/name
  // for properly-scoped Invoked / InvokeRejected event emission.
  const refs: Array<{ kind: string; name: string }> = [];
  for (const h of (resource.handlers ?? []) as unknown[]) {
    refs.push(ctx.resolveChildren(h));
  }
  return new LambdaFunction(
    ctx,
    resource as FunctionManifest,
    refs,
    resource?.metadata?.name as string,
  );
}
