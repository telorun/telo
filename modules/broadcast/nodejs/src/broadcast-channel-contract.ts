import type { InvokeContext } from "@telorun/sdk";

/**
 * The broadcast channel interface (normative: `docs/channel-contract.md`).
 *
 * A channel moves opaque payloads. Topics, the message type, the byte bound and
 * every code are the operation kinds' — a backend only sends a payload to every
 * live listener, reports a gap when it may have lost some, and joins the
 * caller's transaction when its storage has one. A backend is recognised by its
 * methods, never by its class or by having imported this module.
 */
export interface BroadcastChannel {
  /** What the channel was configured with, as the operations need it. A backend
   *  computes it once at creation — `broadcastSettingsOf` does that for it. */
  settings(): BroadcastSettings;
  /**
   * Send a payload (the text `encodeBroadcastPayload` produced) to every
   * listener live at the moment it is sent. `ctx` is the calling invocation's
   * context: a backend with transactions finds the caller's open transaction
   * through it (`ctx.zonesFor(connection, ctx)`) and delivers on commit; one
   * without sends at once. A failure of the transport is thrown as it arrives.
   */
  publish(payload: string, ctx?: InvokeContext): Promise<void>;
  /**
   * Start receiving. The listener hears every payload sent on the channel —
   * topic matching is the subscriber's — in the order the channel delivers
   * them, and a gap whenever messages may have been missed. Resolves once
   * receiving has begun; the handle's `close` ends it and releases whatever the
   * subscription held.
   */
  subscribe(listener: BroadcastListener): Promise<BroadcastSubscriptionHandle> | BroadcastSubscriptionHandle;
}

export interface BroadcastListener {
  /** One payload. Never throws and does not wait for the work it starts. */
  receive(payload: string): void;
  /** Messages may have been missed; `reason` says why, for the log. */
  gap(reason: string): void;
}

export interface BroadcastSubscriptionHandle {
  close(): Promise<void> | void;
}

export interface BroadcastSettings {
  /** The channel's durable identity (`^[a-z][a-z0-9_]{0,47}$`). */
  readonly name: string;
  /** The JSON Schema every message satisfies. */
  readonly messageType: Record<string, unknown>;
  /** The largest encoded payload, its topic included, in UTF-8 bytes. */
  readonly maxBytes: number;
}

const METHODS = ["settings", "publish", "subscribe"] as const;

export function isBroadcastChannel(value: unknown): value is BroadcastChannel {
  return (
    value !== null &&
    typeof value === "object" &&
    METHODS.every((method) => typeof (value as Record<string, unknown>)[method] === "function")
  );
}
