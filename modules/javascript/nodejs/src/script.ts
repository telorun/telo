import {
    Stream,
    type ControllerContext,
    type ResourceContext,
    type RuntimeResource,
} from "@telorun/sdk";

type JavaScriptResource = RuntimeResource & {
  code?: string;
  inputType?: string | Record<string, any>;
  outputType?: string | Record<string, any>;
};

export function register(ctx: ControllerContext): void {}

/** `inputType` / `outputType` are declared but never read here: the kernel binds
 *  the resolved contract to this instance at creation and validates both
 *  directions around `invoke()`. Validating again would double-check every call
 *  and let this controller's wording pre-empt the kernel's, which names the
 *  target and the side that supplied the bad value. */
class JavaScript {
  constructor(
    readonly ctx: ResourceContext,
    readonly compiled: (input: any, telo: any) => Promise<any>,
  ) {}

  async invoke(input: any) {
    // `telo` exposes Telo runtime primitives (currently `Stream` for wrapping
    // AsyncIterables on stream-typed properties). Adding more entries is a
    // non-breaking, additive change — scripts destructure what they need.
    return this.compiled(input, { Stream });
  }
}

export async function create(
  resource: JavaScriptResource,
  ctx: ResourceContext,
): Promise<JavaScript> {
  const name = resource.metadata.name;
  if (!resource.code) {
    throw new Error(`JavaScript "${name}" is missing code`);
  }
  return new JavaScript(ctx, compileJavaScriptModule(resource.code));
}

function compileJavaScriptModule(code: string): (input: any, telo: any) => Promise<any> {
  const wrapped =
    `"use strict";\nconst { Stream } = telo;\n${code}\n` +
    `if (typeof main !== "function") { throw new Error("JavaScript resource must export main(input)"); }\n` +
    `return main(input);`;
  const fn = new Function("input", "telo", wrapped) as (input: any, telo: any) => Promise<any>;
  return fn;
}
