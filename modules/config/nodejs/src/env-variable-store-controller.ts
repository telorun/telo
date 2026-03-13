import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { ConfigStoreHandle } from "./store-handle.js";

type EnvVariableStoreResource = RuntimeResource & {
  schema: Record<string, Record<string, unknown>>;
};

class EnvironmentVariableStore implements ResourceInstance, ConfigStoreHandle {
  private _values: Record<string, string> = {};

  constructor(private readonly resource: EnvVariableStoreResource) {}

  async init(ctx: ResourceContext): Promise<void> {
    ctx.validateSchema(process.env, this.resource.schema);
    for (const key of Object.keys(this.resource.schema)) {
      this._values[key] = process.env[key]!;
    }
  }

  get(key: string): string | undefined {
    return this._values[key];
  }

  getAll(): Record<string, string | undefined> {
    return { ...this._values };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function create(
  resource: EnvVariableStoreResource,
  _ctx: ResourceContext,
): ResourceInstance {
  return new EnvironmentVariableStore(resource);
}
