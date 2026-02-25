import type { ResourceContext } from "@telorun/sdk";

interface Flow {
  metadata: {
    name: string;
    description?: string;
  };
  steps: Array<{
    kind: string;
    metadata: { name: string; module: string };
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
    this.ctx.on(this.resource.trigger.event, async () => {
      // Trigger execution when the specified event occurs
      await this.executeSteps();
    });
  }

  private async executeSteps(): Promise<void> {
    const context: Record<string, any> = {};
    for (const step of this.resource.steps) {
      const { kind, name } = step.invoke;
      const input = this.ctx.expandValue(step.inputs || {}, context);
      const result = await this.ctx.invoke(kind, name, input);
      if (result != null && step.name) {
        context[step.name] = { outputs: result };
      }
    }
  }
}

export function register() {}

export function create(resource: any, ctx: ResourceContext) {
  return new Flow(resource, ctx);
}
