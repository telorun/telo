import { Static, Type } from "@sinclair/typebox";
import type { ResourceContext } from "@telorun/sdk";

export const schema = Type.Object({
  metadata: Type.Record(Type.String(), Type.String()),
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
      // Resolve children handles both inline definitions and references
      // Returns normalized {kind, name} reference
      const resolved = this.ctx.resolveChildren(step.invoke, step.name);
      this.resolvedInvokes.push(resolved);
    }
  }

  async run() {
    await this.executeSteps();
  }

  private async executeSteps(): Promise<void> {
    const context: any = {};
    for (let i = 0; i < this.resource.steps.length; i++) {
      const step = this.resource.steps[i];
      const invoke = this.resolvedInvokes[i];
      try {
        const result = await this.ctx.invoke(
          invoke.kind,
          invoke.name,
          this.ctx.expandValue(step.inputs || {}, context),
        );
        context[step.name] = {
          outputs: result,
        };
      } catch (error) {
        throw error;
      }
    }
  }
}

export function register() {}

export function create(resource: any, ctx: ResourceContext) {
  return new PipelineJob(ctx, resource);
}
