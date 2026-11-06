import { durationMs, RuntimeError, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { digestOf, digestsEqual, parseKey } from "./key-format.js";
import { durationOfMillis, millisOfTimestamp } from "./instants.js";
import { principalOf } from "./key-principal.js";
import { callStore } from "./store-failure.js";
import { isKeySource, type KeySource } from "./store-contract.js";

export const ERR_API_KEY_PREFIX_DUPLICATE = "ERR_API_KEY_PREFIX_DUPLICATE";

const DEFAULT_LAST_USED_RESOLUTION_MS = 3_600_000;

/** Why a key was refused; the closed list `docs/verifier.md` documents. */
export type KeyRefusalReason = "malformed" | "unknown" | "revoked" | "expired";

interface VerifierResource {
  metadata: { name: string };
  sources: unknown[];
  lastUsedResolution?: unknown;
}

interface VerifierInputs {
  presentation: { type: string; token?: string };
}

function refuse(reason: KeyRefusalReason) {
  return { refused: true as const, reason, challenge: null };
}

class ApiKeyVerifier implements ResourceInstance {
  constructor(
    private readonly describe: string,
    private readonly via: string,
    private readonly sourceByPrefix: ReadonlyMap<string, KeySource>,
    private readonly resolutionMs: number,
  ) {}

  async invoke(inputs: VerifierInputs, invokeCtx?: InvokeContext) {
    const { presentation } = inputs;
    // Only `token` presentations carry an API key; any other variant is not one.
    if (presentation.type !== "token" || typeof presentation.token !== "string") return refuse("malformed");

    // Shape, checksum and id are read before any source is asked.
    const parsed = parseKey(presentation.token);
    if (!parsed.ok) return refuse("malformed");
    const source = this.sourceByPrefix.get(parsed.prefix);
    if (!source) return refuse("malformed");

    const found = await callStore(this.describe, () => source.lookup(parsed.uuid, invokeCtx));
    if (found.outcome !== "found") return refuse("unknown");
    const key = found.key;
    if (!digestsEqual(digestOf(presentation.token), key.digest)) return refuse("unknown");

    const now = Date.now();
    if (key.revokedAt !== null) return refuse("revoked");
    if (key.expiresAt !== null && millisOfTimestamp(key.expiresAt) <= now) return refuse("expired");

    // The conditional write is the guard across replicas; reading the last use
    // here only spares the round trip while it is certainly fresh.
    if (
      typeof source.touch === "function" &&
      (key.lastUsedAt === null || now - millisOfTimestamp(key.lastUsedAt) >= this.resolutionMs)
    ) {
      const touch = source.touch.bind(source);
      await callStore(this.describe, () => touch(key.id, durationOfMillis(this.resolutionMs), invokeCtx));
    }
    return { principal: principalOf(key, this.via) };
  }

  snapshot(): Record<string, unknown> {
    // A refusal contributes no challenge of its own; the credential source
    // names the scheme the caller is asked to send.
    return { challenges: [] };
  }
}

// ERR_API_KEY_PREFIX_DUPLICATE is the creation-time twin of API_KEY_PREFIX_DUPLICATE.
export async function create(resource: VerifierResource, ctx: ResourceContext): Promise<ApiKeyVerifier> {
  const describe = `ApiKey.Verifier "${resource.metadata.name}"`;
  const sourceByPrefix = new Map<string, KeySource>();
  for (const [index, ref] of resource.sources.entries()) {
    const source = ctx.resolveRef(ref, isKeySource, () => `${describe}: 'sources[${index}]'`, "ApiKey.KeySource");
    const { prefix } = source.settings();
    if (sourceByPrefix.has(prefix)) {
      throw new RuntimeError(
        ERR_API_KEY_PREFIX_DUPLICATE,
        `${describe}: 'sources[${index}]' has the prefix "${prefix}", which an earlier source already has; a key is routed to its source by prefix.`,
      );
    }
    sourceByPrefix.set(prefix, source);
  }
  const resolutionMs =
    resource.lastUsedResolution === undefined
      ? DEFAULT_LAST_USED_RESOLUTION_MS
      : durationMs(resource.lastUsedResolution);
  if (resolutionMs === undefined || resolutionMs <= 0) {
    throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: 'lastUsedResolution' must be a positive duration.`);
  }
  return new ApiKeyVerifier(describe, String(resource.metadata.name), sourceByPrefix, resolutionMs);
}

export function register(): void {}
