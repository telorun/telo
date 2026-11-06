import { randomBytes } from "node:crypto";
import {
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

interface DeclaredUser {
  passwordHash: string;
  subject?: string;
  roles?: string[];
  scopes?: string[];
  claims?: Record<string, unknown>;
}

interface DeclaredUsersResource {
  metadata: { name: string };
  hasher: unknown;
  users: Record<string, DeclaredUser>;
}

type Hasher = (inputs: Record<string, unknown>, invokeCtx?: InvokeContext) => Promise<unknown>;

/**
 * Identity.DeclaredUsers — users written in the manifest. An identifier it does
 * not hold is verified against a hash made when it was created, so the work
 * done, and therefore the time taken, is that of a wrong password.
 */
class DeclaredUsers implements ResourceInstance {
  constructor(
    private readonly name: string,
    private readonly hash: Hasher,
    private readonly users: ReadonlyMap<string, DeclaredUser>,
    private readonly dummyHash: string,
  ) {}

  async invoke(inputs: { identifier: string; password: string }, invokeCtx?: InvokeContext) {
    const user = this.users.get(inputs.identifier);
    const verdict = (await this.hash(
      { op: "verify", password: inputs.password, hash: user?.passwordHash ?? this.dummyHash },
      invokeCtx,
    )) as { valid: boolean };
    if (user === undefined) return { refused: true as const, reason: "unknown" as const };
    if (!verdict.valid) return { refused: true as const, reason: "mismatch" as const };
    return {
      principal: {
        subject: user.subject ?? inputs.identifier,
        issuer: null,
        kind: "user" as const,
        claims: { ...user.claims },
        scopes: [...(user.scopes ?? [])],
        roles: [...(user.roles ?? [])],
        permissions: [] as string[],
        org: null,
        amr: ["pwd"],
        acr: null,
        sessionId: null,
        authenticatedAt: null,
        via: this.name,
      },
    };
  }

  snapshot(): Record<string, unknown> {
    return { users: this.users.size };
  }
}

export async function create(resource: DeclaredUsersResource, ctx: ResourceContext): Promise<DeclaredUsers> {
  const describe = `Identity.DeclaredUsers "${resource.metadata.name}"`;
  const hash = resolveInvocableDispatcher(resource.hasher, ctx, () => `${describe}: 'hasher'`);
  const dummy = (await hash({ op: "hash", password: randomBytes(24).toString("base64url") })) as { hash: string };
  return new DeclaredUsers(
    String(resource.metadata.name),
    hash,
    new Map(Object.entries(resource.users)),
    dummy.hash,
  );
}

export function register(): void {}
