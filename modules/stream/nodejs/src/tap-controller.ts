import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream, resolveInvocableDispatcher } from "@telorun/sdk";
import { elementBindings, type ElementBindings } from "./element-bindings.js";
import { requireStream } from "./stream-input.js";

interface TapResource {
  metadata: { name: string; module?: string };
  invoke?: unknown;
  inputs?: unknown;
  when?: unknown;
}

interface TapInputs {
  input?: unknown;
}

interface TapOutputs {
  output: Stream<unknown>;
}

type Dispatch = (
  inputs: Record<string, unknown>,
  invokeCtx?: InvokeContext,
) => Promise<unknown>;

/**
 * Every value passes through unchanged; each is handed to the handler first.
 *
 * Dispatch-before-delivery is the contract: the handler is awaited before the
 * value is yielded, so what it observed is exactly what the consumer received,
 * even when the consumer stops early — and a value whose handler failed never
 * reaches the consumer at all.
 *
 * The handler runs under the context this tap was INVOKED with, captured here and
 * passed to every dispatch. A generator body resumes in whatever context the
 * drainer happens to hold, and reading that would make cancellation and tracing
 * depend on who pulled rather than on who asked for the stream — and on a runtime
 * mechanism the SDK deliberately keeps off its surface.
 */
class StreamTap implements ResourceInstance<TapInputs, TapOutputs> {
  constructor(
    private readonly resource: TapResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: TapInputs, invokeCtx?: InvokeContext): Promise<TapOutputs> {
    const name = this.resource.metadata.name;
    const input = requireStream(inputs?.input, "Stream.Tap", name);
    // Resolved before anything is pulled, so a bad reference fails this call
    // rather than surfacing at the first value.
    const dispatch = resolveInvocableDispatcher(
      this.resource.invoke,
      this.ctx,
      () => `Stream.Tap "${name}"`,
    );
    return { output: new Stream(this.tap(input, dispatch, invokeCtx)) };
  }

  private async *tap(
    input: AsyncIterable<unknown>,
    dispatch: Dispatch,
    invokeCtx: InvokeContext | undefined,
  ): AsyncIterable<unknown> {
    for await (const scope of elementBindings(input)) {
      if (this.gate(scope)) {
        const args =
          this.resource.inputs === undefined
            ? {}
            : (this.ctx.expandValue(this.resource.inputs, scope) as Record<string, unknown>);
        await dispatch(args, invokeCtx);
      }
      yield scope.item;
    }
  }

  private gate(scope: ElementBindings): boolean {
    if (this.resource.when === undefined) return true;
    const verdict = this.ctx.expandValue(this.resource.when, scope);
    if (typeof verdict !== "boolean") {
      throw new InvokeError(
        "ERR_INVALID_VALUE",
        `Stream.Tap "${this.resource.metadata.name}": 'when' must evaluate to a boolean; ` +
          `element ${scope.index} produced ${verdict === null ? "null" : typeof verdict}.`,
      );
    }
    return verdict;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: TapResource,
  ctx: ResourceContext,
): Promise<StreamTap> {
  return new StreamTap(resource, ctx);
}
