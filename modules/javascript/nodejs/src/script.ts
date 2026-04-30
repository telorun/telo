import {
    Stream,
    type ControllerContext,
    type DataValidator,
    type ResourceContext,
    type RuntimeResource,
} from "@telorun/sdk";

type JavaScriptResource = RuntimeResource & {
  code?: string;
  inputType?: string | Record<string, any>;
  outputType?: string | Record<string, any>;
};

export function register(ctx: ControllerContext): void {}

class JavaScript {
  constructor(
    readonly ctx: ResourceContext,
    readonly inputValidator: DataValidator,
    readonly outputValidator: DataValidator,
    readonly compiled: (input: any, telo: any) => Promise<any>,
  ) {}

  async invoke(input: any) {
    this.inputValidator.validate(input);
    // `telo` exposes Telo runtime primitives (currently `Stream` for wrapping
    // AsyncIterables on stream-typed properties). Adding more entries is a
    // non-breaking, additive change — scripts destructure what they need.
    const output = await this.compiled(input, { Stream });
    this.outputValidator.validate(output);
    return output;
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
  const compiled = compileJavaScriptModule(resource.code);
  return new JavaScript(
    ctx,
    ctx.createTypeValidator(resource.inputType),
    ctx.createTypeValidator(resource.outputType),
    compiled,
  );
}

function compileJavaScriptModule(code: string): (input: any, telo: any) => Promise<any> {
  const wrapped =
    `"use strict";\nconst { Stream } = telo;\n${code}\n` +
    `if (typeof main !== "function") { throw new Error("JavaScript resource must export main(input)"); }\n` +
    `return main(input);`;
  const fn = new Function("input", "telo", wrapped) as (input: any, telo: any) => Promise<any>;
  return fn;
}
