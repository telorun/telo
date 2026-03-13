import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { ConfigStoreHandle } from "./store-handle.js";

type SecretsResource = RuntimeResource & {
  storeRef: { name: string };
  keys: Record<string, string>;
};

const TEMPLATE_RE = /\$\{\{/;

class Secrets implements ResourceInstance {
  private _values: Record<string, string> = {};

  constructor(
    private readonly resource: SecretsResource,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {
    const store = this.ctx.moduleContext.getInstance(
      this.resource.storeRef.name,
    ) as ConfigStoreHandle;

    const missing: string[] = [];

    for (const [localName, value] of Object.entries(this.resource.keys)) {
      let resolved: string | undefined;

      if (TEMPLATE_RE.test(value)) {
        resolved = this.ctx.expandValue(value, store.getAll()) as string | undefined;
      } else {
        resolved = store.get(value);
      }

      if (resolved === undefined) {
        missing.push(TEMPLATE_RE.test(value) ? `${localName} (CEL expression)` : `${localName} (${value})`);
      } else {
        this._values[localName] = resolved;
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Config.Secrets "${this.resource.metadata.name}": ` +
          `required key(s) are not set: ${missing.join(", ")}`,
      );
    }
  }

  snapshot(): Record<string, unknown> {
    return { ...this._values };
  }
}

export function create(resource: SecretsResource, ctx: ResourceContext): ResourceInstance {
  return new Secrets(resource, ctx);
}
