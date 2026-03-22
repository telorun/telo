import { Static, Type } from "@sinclair/typebox";
import type {
  Injected,
  Invocable,
  KindRef,
  ResourceContext,
  ScopeContext,
  ScopeRef,
} from "@telorun/sdk";

export const schema = Type.Object({
  metadata: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
  with: Type.Optional(Type.Unsafe<ScopeRef>({ "x-telo-scope": "/steps" })),
  steps: Type.Array(
    Type.Object({
      name: Type.String(),
      invoke: Type.Unsafe<KindRef<Invocable>>({
        anyOf: [{ "x-telo-ref": "kernel#Invocable" }, { "x-telo-ref": "kernel#Runnable" }],
      }),
      outputs: Type.Optional(Type.Record(Type.String(), Type.Any())),
      inputs: Type.Record(Type.String(), Type.Any()),
    }),
  ),
});
type PipelineJobManifest = Injected<Static<typeof schema>>;

class PipelineJob {
  constructor(
    private ctx: ResourceContext,
    public resource: PipelineJobManifest,
  ) {}

  async run() {
    const scopeHandle = this.resource.with;
    if (scopeHandle) {
      await scopeHandle.run(async (scope) => {
        await this.executeSteps(scope);
      });
    } else {
      await this.executeSteps();
    }
  }

  async teardown() {}

  private async executeSteps(scope?: ScopeContext): Promise<void> {
    const context: any = {};
    for (const step of this.resource.steps) {
      const raw = step.invoke as unknown;
      // After Phase 5: outer resources are live instances; scoped resources remain {kind,name}
      const invocable: Invocable =
        raw && typeof (raw as any).invoke === "function"
          ? (raw as Invocable)
          : (scope!.getInstance((raw as KindRef<Invocable>).name) as unknown as Invocable);
      const result = await invocable.invoke(this.ctx.expandValue(step.inputs || {}, context));
      context[step.name] = { outputs: result };
    }
  }
}

export function register() {}

export async function create(resource: any, ctx: ResourceContext) {
  const job = new PipelineJob(ctx, resource);
  return job as any;
}
