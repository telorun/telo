import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  RuntimeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { postToTokenEndpoint, scopeParam, withDeadline } from "./token-endpoint.js";
import { parseTokenSet, TokenEndpointError } from "./token-set.js";
import { resolveSource, type TokenSourceResource } from "./token-source.js";

interface SourceManifest {
  metadata?: { name?: string };
  source: unknown;
}

abstract class DeviceOperation implements ResourceInstance {
  protected readonly source: TokenSourceResource;

  constructor(manifest: SourceManifest, ctx: ResourceContext, kind: string) {
    this.source = resolveSource(
      manifest.source,
      ctx,
      () => `OAuthClient.${kind} "${manifest.metadata?.name ?? ""}"`,
    );
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export class DeviceAuthorizationResource extends DeviceOperation {
  async invoke(inputs: { scopes?: string[] }, invokeCtx?: InvokeContext) {
    const client = this.source.client;
    const { deviceAuthorizationEndpoint, timeoutMs } = await client.endpoints();
    if (!deviceAuthorizationEndpoint) {
      throw new RuntimeError(
        "ERR_OAUTH_NO_DEVICE_ENDPOINT",
        "This authorization server publishes no device authorization endpoint. " +
          "Set 'deviceAuthorizationEndpoint' on the AuthorizationServer if it supports the device grant.",
      );
    }

    const body = new URLSearchParams({ client_id: client.clientId });
    const scope = scopeParam(inputs?.scopes ?? client.scopes);
    if (scope) body.set("scope", scope);
    if (client.clientSecret !== null) body.set("client_secret", client.clientSecret);

    const response = await withDeadline(
      deviceAuthorizationEndpoint,
      timeoutMs,
      invokeCtx?.cancellation.signal,
      (signal) =>
        fetch(deviceAuthorizationEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body,
          signal,
        }),
    );
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !payload || typeof payload.device_code !== "string") {
      throw new RuntimeError(
        "ERR_OAUTH_DEVICE_AUTHORIZATION_FAILED",
        `Device authorization endpoint returned HTTP ${response.status} without a device_code.`,
      );
    }

    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 600;
    return {
      deviceCode: payload.device_code,
      userCode: String(payload.user_code ?? ""),
      verificationUri: String(payload.verification_uri ?? payload.verification_url ?? ""),
      verificationUriComplete:
        typeof payload.verification_uri_complete === "string"
          ? payload.verification_uri_complete
          : null,
      expiresAt: Date.now() + expiresIn * 1000,
      interval: typeof payload.interval === "number" ? payload.interval : 5,
    };
  }
}

/** Wait, but wake immediately if the invocation is cancelled — a poll loop that
 *  ignores the signal keeps running for minutes after SIGINT. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class DeviceTokenResource extends DeviceOperation {
  async invoke(
    inputs: { deviceCode: string; interval?: number; expiresAt?: number; key?: string },
    invokeCtx?: InvokeContext,
  ) {
    const key = this.source.grantKey(inputs.key);
    const deadline = inputs.expiresAt ?? Date.now() + 600_000;
    const signal = invokeCtx?.cancellation.signal;
    let intervalMs = (inputs.interval ?? 5) * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs, signal);
      if (signal?.aborted) {
        throw new InvokeError(ERR_INVOKE_CANCELLED, "Device authorization polling was cancelled");
      }
      try {
        const payload = await postToTokenEndpoint(
          this.source.client,
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: inputs.deviceCode,
          },
          signal,
        );
        const tokens = parseTokenSet(payload, Date.now());
        await this.source.writeGrant(key, tokens);
        return {
          ok: true,
          reason: null,
          key,
          scope: tokens.scope,
          expiresAt: tokens.expiresAt,
        };
      } catch (err) {
        if (!(err instanceof TokenEndpointError)) throw err;
        switch (err.error) {
          case "authorization_pending":
            continue;
          case "slow_down":
            // RFC 8628 §3.5 — the server is asking for a longer gap, and every
            // subsequent poll must honour it, not just the next one.
            intervalMs += 5_000;
            continue;
          case "access_denied":
            return { ok: false, reason: "denied", key: null, scope: null, expiresAt: null };
          case "expired_token":
            return { ok: false, reason: "expired", key: null, scope: null, expiresAt: null };
          default:
            throw err;
        }
      }
    }
    return { ok: false, reason: "expired", key: null, scope: null, expiresAt: null };
  }
}

export const deviceAuthorization = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: SourceManifest, ctx: ResourceContext) {
    return new DeviceAuthorizationResource(resource, ctx, "DeviceAuthorization");
  },
};

export const deviceToken = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: SourceManifest, ctx: ResourceContext) {
    return new DeviceTokenResource(resource, ctx, "DeviceToken");
  },
};
