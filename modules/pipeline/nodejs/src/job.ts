import { Static, Type } from "@sinclair/typebox";
import type { ResourceContext } from "@telorun/sdk";

export const schema = Type.Object({
  metadata: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
  with: Type.Optional(
    Type.Array(
      Type.Object(
        {
          kind: Type.String(),
          name: Type.Optional(Type.String()),
          metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
        },
        { additionalProperties: true },
      ),
    ),
  ),
  steps: Type.Array(
    Type.Object({
      name: Type.String(),
      invoke: Type.Object({
        kind: Type.String(),
        name: Type.Optional(Type.String()),
        metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      outputs: Type.Optional(Type.Record(Type.String(), Type.Any())),
      inputs: Type.Record(Type.String(), Type.Any()),
    }),
  ),
});
type PipelineJobManifest = Static<typeof schema>;

class PipelineJob {
  constructor(
    private ctx: ResourceContext,
    public resource: PipelineJobManifest,
  ) {}

  private resolvedInvokes: Array<{ kind: string; name: string }> = [];

  async init() {
    for (const step of this.resource.steps) {
      const resolved = this.ctx.resolveChildren(step.invoke, step.name);
      this.resolvedInvokes.push(resolved);
    }
  }

  async run() {
    // const toCreate = this.resource.steps
    //   .map((step) => step.invoke)
    //   .filter((invoke) => Object.keys(invoke).length !== 2);
    // console.log("toCreate", toCreate, this.resolvedInvokes);

    await this.ctx.withManifests([...(this.resource.with ?? [])], async () => {
      await this.executeSteps();
    });
  }

  async teardown() {}

  private async executeSteps(): Promise<void> {
    const context: any = {};
    for (let i = 0; i < this.resource.steps.length; i++) {
      const step = this.resource.steps[i];
      const invoke = this.resolvedInvokes[i];

      const result = await this.ctx.invoke(
        invoke.kind,
        invoke.name,
        this.ctx.expandValue(step.inputs || {}, context),
      );
      context[step.name] = {
        outputs: result,
      };
    }
  }
}

export function register() {}

export async function create(resource: any, ctx: ResourceContext) {
  const job = new PipelineJob(ctx, resource);
  return job as any;
}
