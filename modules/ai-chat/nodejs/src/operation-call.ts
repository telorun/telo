import {
  getRefIdentity,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

const isInvocable = (candidate: unknown): candidate is ResourceInstance =>
  typeof (candidate as ResourceInstance | null)?.invoke === "function";

/**
 * One operation a controller reaches through a `use: call` slot, dispatched
 * through the kernel so its contract, its span and the caller's cancellation
 * apply to every call.
 */
export class OperationCall {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly slot: unknown,
    private readonly describe: string,
  ) {}

  invoke<T = any>(inputs: Record<string, unknown>, invokeCtx?: InvokeContext): Promise<T> {
    const instance = this.ctx.resolveRef(this.slot, isInvocable, () => this.describe);
    const identity = getRefIdentity(instance as object);
    return this.ctx.invokeResolved(
      identity?.kind ?? "",
      identity?.name ?? this.describe,
      instance,
      inputs,
      invokeCtx,
    );
  }
}

/** The operations of a resource's `use: call` slots, by slot name. */
export function operationsOf<K extends string>(
  ctx: ResourceContext,
  resource: Record<string, unknown> & { metadata: { name: string } },
  kind: string,
  slots: readonly K[],
): Record<K, OperationCall> {
  const out = {} as Record<K, OperationCall>;
  for (const slot of slots) {
    out[slot] = new OperationCall(ctx, resource[slot], `${kind} "${resource.metadata.name}": '${slot}'`);
  }
  return out;
}
