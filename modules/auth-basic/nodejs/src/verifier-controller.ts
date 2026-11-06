import {
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

interface VerifierResource {
  metadata: { name: string };
  passwords: unknown;
  realm: string;
}

interface VerifierInputs {
  presentation: { type: string; username?: string; password?: string };
}

type PasswordAnswer =
  | { principal: Record<string, unknown> }
  | { refused: true; reason: string };

interface Challenge {
  scheme: "Basic";
  parameters: { realm: string; charset: "UTF-8" };
}

class BasicVerifier implements ResourceInstance {
  constructor(
    private readonly name: string,
    private readonly challenge: Challenge,
    private readonly check: (inputs: Record<string, unknown>, invokeCtx?: InvokeContext) => Promise<unknown>,
  ) {}

  private refuse(reason: string) {
    return { refused: true as const, reason, challenge: this.challenge };
  }

  async invoke(inputs: VerifierInputs, invokeCtx?: InvokeContext) {
    const { presentation } = inputs;
    if (presentation.type !== "basic" || typeof presentation.username !== "string" || typeof presentation.password !== "string") {
      return this.refuse("malformed");
    }
    const answer = (await this.check(
      { identifier: presentation.username, password: presentation.password },
      invokeCtx,
    )) as PasswordAnswer;
    if ("principal" in answer) return { principal: { ...answer.principal, via: this.name } };
    return this.refuse(answer.reason);
  }

  snapshot(): Record<string, unknown> {
    return { challenges: [this.challenge] };
  }
}

export async function create(resource: VerifierResource, ctx: ResourceContext): Promise<BasicVerifier> {
  const describe = `AuthBasic.Verifier "${resource.metadata.name}"`;
  const check = resolveInvocableDispatcher(resource.passwords, ctx, () => `${describe}: 'passwords'`);
  const challenge: Challenge = { scheme: "Basic", parameters: { realm: resource.realm, charset: "UTF-8" } };
  return new BasicVerifier(String(resource.metadata.name), challenge, check);
}

export function register(): void {}
