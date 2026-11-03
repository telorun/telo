import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import type { QueueSettings } from "./queue-store-contract.js";

/** The bound `maxMessageBytes` defaults to — the abstract's declared default,
 *  which the kernel validates against but never writes into a resource. */
export const DEFAULT_MAX_MESSAGE_BYTES = 262144;

interface QueueResource {
  metadata?: { name?: string };
  messageType?: unknown;
  maxMessageBytes?: unknown;
}

/**
 * The settings every queue store answers `settings()` with, read from the
 * fields the queue abstract declares. A backend calls it in `create()` and
 * keeps the answer.
 */
export function queueSettingsOf(resource: QueueResource, ctx: ResourceContext): QueueSettings {
  const owner = `Queue "${resource.metadata?.name ?? "?"}"`;
  return Object.freeze({
    messageType: messageTypeSchema(resource.messageType, ctx, owner),
    maxMessageBytes:
      resource.maxMessageBytes === undefined || resource.maxMessageBytes === null
        ? DEFAULT_MAX_MESSAGE_BYTES
        : Number(resource.maxMessageBytes),
  });
}

// The same reading as `modelSchema` in modules/crud/nodejs/src/model-schema.ts.
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
