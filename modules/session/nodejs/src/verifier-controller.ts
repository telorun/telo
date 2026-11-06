import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { timestampOfMillis } from "./instants.js";
import { BoundSessionOperation, type OperationResource } from "./session-operation.js";
import { publicIdOf } from "./session-token.js";

interface VerifierInputs {
  presentation: { type: string; token?: string };
}

function refuse(reason: string) {
  return { refused: true as const, reason, challenge: null };
}

class SessionVerifier implements ResourceInstance {
  constructor(
    private readonly bound: BoundSessionOperation,
    private readonly via: string,
  ) {}

  async invoke(inputs: VerifierInputs) {
    const { presentation } = inputs;
    // Only `token` presentations carry a session token; any other variant is not one.
    if (presentation.type !== "token" || typeof presentation.token !== "string") return refuse("malformed");

    const verdict = await this.bound.sessions.verify(presentation.token);
    if (!verdict.accepted) return refuse(verdict.reason);

    const { record } = verdict;
    return {
      principal: {
        subject: record.principal.subject,
        issuer: record.principal.issuer,
        kind: record.principal.kind,
        claims: record.principal.claims,
        scopes: [...record.principal.scopes],
        roles: [...record.principal.roles],
        permissions: [...record.principal.permissions],
        org: record.principal.org,
        amr: [...record.amr],
        acr: record.acr,
        sessionId: publicIdOf(verdict.id),
        authenticatedAt: timestampOfMillis(record.authenticatedAt),
        via: this.via,
      },
    };
  }

  snapshot(): Record<string, unknown> {
    // The credential source names the scheme a caller is asked to send; a
    // session adds no challenge of its own.
    return { challenges: [] };
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<SessionVerifier> {
  return new SessionVerifier(new BoundSessionOperation("Session.Verifier", resource, ctx), String(resource.metadata.name));
}

export function register(): void {}
