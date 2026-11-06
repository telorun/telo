import type { ResourceContext, ResourceInstance, ResourceManifest } from "@telorun/sdk";

interface Rule {
  when: unknown;
  allow?: boolean;
  reason?: string;
  requiredScopes?: string[];
}

interface CelPolicyResource extends ResourceManifest {
  rules: Rule[];
}

interface PolicyInputs {
  principal: unknown;
  action: string;
  resource: unknown;
  context: Record<string, unknown>;
}

export function register(): void {}

export async function create(
  resource: CelPolicyResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  return {
    async invoke(inputs: Record<string, any>) {
      const { principal, action, resource: target, context } = inputs as PolicyInputs;
      const bindings = { principal, action, resource: target, context };
      for (const rule of resource.rules) {
        if (ctx.expandValue(rule.when, bindings) !== true) continue;
        return {
          allow: rule.allow ?? true,
          ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
          ...(rule.requiredScopes !== undefined ? { requiredScopes: rule.requiredScopes } : {}),
        };
      }
      return { allow: false, reason: "no rule matched" };
    },
    snapshot() {
      return {};
    },
  };
}
