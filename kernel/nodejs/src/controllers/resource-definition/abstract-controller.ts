import type {
  ControllerContext,
  ResourceContext,
  ResourceInstance,
  RuntimeResource,
} from "@telorun/sdk";
import { formatAjvErrors, validateResourceAbstract } from "../../manifest-schemas.js";

type ResourceAbstractResource = RuntimeResource & {
  kind: "Telo.Abstract";
  metadata: {
    [key: string]: any;
    name: string;
    module?: string;
  };
  schema?: Record<string, any>;
  capability?: string;
};

/**
 * Telo.Abstract meta-controller.
 *
 * An abstract declares a contract that other definitions may implement via `extends`
 * (or the legacy `capability: <AbstractKind>` overload). It has no runtime instance
 * of its own and no controller to load — the `init()` just registers the definition
 * with the kernel's ControllerRegistry so `getDefinition(<abstractKind>)` returns it
 * during capability-chain resolution and so `snapshot()` calls from the abstract's
 * extendedBy children can resolve its schema for runtime validation.
 */
class ResourceAbstract implements ResourceInstance {
  readonly kind: "ResourceAbstract" = "ResourceAbstract";

  constructor(readonly resource: ResourceAbstractResource) {}

  async init(ctx: ResourceContext) {
    ctx.registerDefinition(this.resource);
  }
}

export function register(_ctx: ControllerContext): void {
  // Abstract is passive — no registration side-effects.
}

export async function create(resource: any, _ctx: ResourceContext): Promise<ResourceAbstract> {
  if (!validateResourceAbstract(resource)) {
    throw new Error(
      `Invalid Telo.Abstract "${resource.metadata?.name}": ${formatAjvErrors(validateResourceAbstract.errors)}`,
    );
  }
  return new ResourceAbstract(resource as unknown as ResourceAbstractResource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
