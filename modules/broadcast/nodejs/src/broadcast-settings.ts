import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import type { BroadcastSettings } from "./broadcast-channel-contract.js";

/** The bound `maxBytes` defaults to — the abstract's declared default, which the
 *  kernel validates against but never writes into a resource. */
export const DEFAULT_MAX_BYTES = 4096;

interface ChannelResource {
  metadata?: { name?: string };
  name?: unknown;
  messageType?: unknown;
  maxBytes?: unknown;
}

/**
 * The settings every channel answers `settings()` with, read from the fields the
 * channel abstract declares. A backend calls it in `create()` and keeps the answer.
 */
export function broadcastSettingsOf(resource: ChannelResource, ctx: ResourceContext): BroadcastSettings {
  const owner = `Broadcast channel "${resource.metadata?.name ?? "?"}"`;
  if (typeof resource.name !== "string") {
    throw new RuntimeError("ERR_RESOURCE_SCHEMA_VALIDATION_FAILED", `${owner}: 'name' must be a string.`);
  }
  return Object.freeze({
    name: resource.name,
    messageType: messageTypeSchema(resource.messageType, ctx, owner),
    maxBytes:
      resource.maxBytes === undefined || resource.maxBytes === null
        ? DEFAULT_MAX_BYTES
        : Number(resource.maxBytes),
  });
}

/** The JSON Schema the `messageType` slot names — a live shape, a reference the
 *  registry holds, or a schema written in place. */
function messageTypeSchema(value: unknown, ctx: ResourceContext, owner: string): Record<string, unknown> {
  if (value && typeof value === "object") {
    const slot = value as Record<string, any>;
    if (slot.schema && typeof slot.schema === "object") return slot.schema;
    const key = typeof slot.$ref === "string" ? slot.$ref : slot.name;
    if (typeof key === "string") {
      const found = ctx.lookupSchema(key);
      if (found) return found as Record<string, unknown>;
    } else if (slot.type || slot.properties || slot.anyOf || slot.oneOf || slot.allOf) {
      return slot;
    }
  }
  throw new RuntimeError("ERR_REF_UNRESOLVED", `${owner}: 'messageType' does not name a data shape.`);
}
