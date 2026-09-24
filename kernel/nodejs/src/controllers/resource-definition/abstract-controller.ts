import type { DefResolver } from "@telorun/analyzer";
import type {
  ControllerContext,
  ResourceContext,
  ResourceDefinition,
  ResourceInstance,
  RuntimeResource,
} from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import { formatAjvErrors, validateResourceAbstract } from "../../manifest-schemas.js";
import { refuseInvalidCallable, type DefinitionScopeHost } from "./callable-guard.js";
import { refuseThrowsOutsideCeiling } from "./throws-ceiling-guard.js";
import {
  forgetRegisteredDefinition,
  recordRegisteredDefinition,
} from "./registered-definitions.js";

type ResourceAbstractResource = RuntimeResource & {
  kind: "Telo.Abstract";
  metadata: {
    [key: string]: any;
    name: string;
    module?: string;
  };
  schema?: Record<string, any>;
  capability?: string;
  extends?: string;
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

  init(ctx: ResourceContext) {
    return ctx.effect(`${this.resource.kind} ${this.resource.metadata.name}`, async () => {
      await this.registerKind(ctx);
      return {
        result: undefined,
        inverse: () =>
          forgetRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy()),
      };
    });
  }

  private async registerKind(ctx: ResourceContext) {
    const definingCtx = ctx.moduleContext;
    const resolveDef: DefResolver = (kind) => {
      let canonical = kind;
      try {
        canonical = definingCtx.resolveKind(kind);
      } catch {
        // ungated / unqualified — fall back to the raw kind below
      }
      return definingCtx.getDefinition?.(canonical) ?? definingCtx.getDefinition?.(kind);
    };

    // Deferred until the ancestor is loaded, the rule the definition controller
    // follows: an abstract stating no capability takes its ancestor's, and the
    // callable guard's verdict turns on it. An `extends` that never resolves
    // therefore fails at boot — `validateExtends` is the static twin.
    if (this.resource.extends && !resolveDef(this.resource.extends)) {
      throw new RuntimeError(
        "ERR_LOCAL_REF_PENDING",
        `Telo.Abstract '${this.resource.metadata.name}': 'extends' target '${this.resource.extends}' is not loaded yet.`,
      );
    }
    // A callable abstract is a signature with no implementation — refused for
    // the same declarations a callable definition is. See `callable-guard.ts`.
    refuseInvalidCallable(
      this.resource as unknown as ResourceDefinition,
      ctx as unknown as DefinitionScopeHost,
    );
    refuseThrowsOutsideCeiling(this.resource as unknown as ResourceDefinition, resolveDef);

    ctx.registerDefinition(this.resource);
    recordRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy());
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

