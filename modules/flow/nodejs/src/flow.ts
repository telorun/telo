import type { Invocable, KindRef, ResourceContext } from "@telorun/sdk";

interface Flow {
  metadata: {
    name: string;
    description?: string;
  };
  steps: Array<{
    name: string;
    invoke?: KindRef<Invocable>;
    outputs?: Record<string, string>; // variable name to JSON path in result
    inputs?: Record<string, any>; // input parameters for the step
  }>;
}

class Flow {
  constructor(
    public readonly resource: any,
    public readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {
    for (const step of this.resource.steps) {
      if (step.invoke) {
        // Resolve children handles both inline definitions and references
        // Returns normalized {kind, name} reference
        step.invoke = this.ctx.resolveChildren(step.invoke, step.name);
      }
    }
    // this.ctx.on(this.resource.trigger.event, async () => {
    //   // Trigger execution when the specified event occurs
    // });
  }

  async run(): Promise<void> {
    await this.executeSteps();
  }

  private async executeSteps(): Promise<void> {
    const outputs: Record<string, any> = {};
    for (const step of this.resource.steps) {
      const { kind, name } = step.invoke;
      const input = this.ctx.expandValue(step.inputs || {}, { outputs });
      const result = await this.ctx.invoke(kind, name, input);
      outputs[name] = result;
    }
  }
}

export function register() {}

export async function create(resource: any, ctx: ResourceContext) {
  return new Flow(resource, ctx);
}
