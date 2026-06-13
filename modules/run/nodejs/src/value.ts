import { type ResourceContext } from "@telorun/sdk";

interface RunValueManifest {
  metadata: Record<string, string | number | boolean>;
  inputs?: Record<string, unknown>;
  value: unknown;
}

/** A pure value/binding Invocable: evaluate the `value` CEL expression (or a
 *  structure with CEL leaves) against the caller's `inputs` and return the
 *  result. The declarative replacement for a `Js.Script` that only shapes a
 *  value — concat, field mapping, a constant literal — with no I/O or branching. */
class RunValue {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: RunValueManifest,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<unknown> {
    return this.ctx.expandValue(this.resource.value, { inputs: inputs ?? {} });
  }
}

export function register(): void {}

export async function create(
  resource: RunValueManifest,
  ctx: ResourceContext,
): Promise<RunValue> {
  return new RunValue(ctx, resource);
}
