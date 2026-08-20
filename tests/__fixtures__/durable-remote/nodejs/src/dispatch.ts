/**
 * The child kernel's half of the seam: resolve a step target from its ENCODED
 * IDENTITY and invoke it.
 *
 * Nothing is handed to this process but a string. It holds none of the parent's
 * instances, so a target that resolves here resolved from what was written down
 * — which is the property the whole fixture exists to test.
 *
 * The identity is checked before it is used: a module that is not this one means
 * the parent is naming a resource this kernel would resolve to a DIFFERENT
 * same-named one, and answering anyway is the failure mode the module field
 * exists to prevent.
 */
import {
  InvokeError,
  decodeDurableTarget,
  getRefIdentity,
  type ResourceContext,
  type ResourceInstance,
  type ResourceManifest,
} from "@telorun/sdk";

interface DispatchManifest extends ResourceManifest {
  /** Every target this kernel is able to execute, by declared name. A map rather
   *  than a list because resolution is BY NAME — that is what arrives. */
  targets: Record<string, ResourceInstance>;
  encodedTarget: string;
  encodedInputs: string;
}

export class DispatchController {
  constructor(
    private readonly resource: DispatchManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(): Promise<string> {
    const target = decodeDurableTarget(this.resource.encodedTarget);
    const instance = this.resource.targets[target.name];
    if (!instance) {
      throw new InvokeError(
        "ERR_REMOTE_TARGET_UNRESOLVED",
        `This kernel declares no target named '${target.name}'. Known: ` +
          `${Object.keys(this.resource.targets).join(", ") || "(none)"}.`,
        { target },
      );
    }
    const local = getRefIdentity(instance as object);
    if (local && local.kind !== target.kind) {
      throw new InvokeError(
        "ERR_REMOTE_TARGET_UNRESOLVED",
        `'${target.name}' is ${local.kind} here and ${target.kind} where the step was ` +
          `declared. Executing it would answer for a different resource.`,
        { target },
      );
    }
    if (local?.origin?.module && target.module && local.origin.module !== target.module) {
      throw new InvokeError(
        "ERR_REMOTE_TARGET_UNRESOLVED",
        `'${target.name}' is declared by ${local.origin.module} here and by ${target.module} ` +
          `where the step was declared — two modules' same-named resources.`,
        { target },
      );
    }
    const inputs = JSON.parse(this.resource.encodedInputs) as Record<string, unknown>;
    // Through the kernel's own chokepoint, never `instance.invoke()`: wherever a
    // step ends up running, the executing side dispatches through its kernel so
    // the invocation contract, tracing, zones and observed state hold
    // identically. That is a conformance requirement of the seam, not a
    // convenience.
    const result = await this.ctx.invokeResolved(
      local?.kind ?? target.kind,
      target.name,
      instance,
      inputs,
    );
    // Serialized HERE rather than by the manifest, because the protocol between
    // the two processes is one JSON line on stdout and the shape of that line is
    // this controller's contract, not the printer's.
    //
    // `via` is stamped so the parent can tell a shipped step from one that
    // quietly ran at home: without it a fixture that silently executed locally
    // would produce an identical, passing result.
    return JSON.stringify({ ...(result as Record<string, unknown>), via: "child-kernel" });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: DispatchManifest,
  ctx: ResourceContext,
): Promise<DispatchController> {
  return new DispatchController(resource, ctx);
}
