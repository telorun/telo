import { InvokeError, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { createHash } from "node:crypto";
import {
  BoundKeyOperation,
  ERR_API_KEY_CURSOR_INVALID,
  keyRecord,
  type OperationResource,
} from "./key-operation.js";
import { storeInconsistent } from "./store-failure.js";
import type { KeyOwner } from "./store-contract.js";

interface ListInputs {
  owner: KeyOwner;
  limit?: number | bigint;
  cursor?: string;
}

const DEFAULT_LIMIT = 50;
const CURSOR_VERSION = 1;

// The public cursor: an envelope this module owns around the tail a store
// returned, bound to the owner it lists. A cursor is a position, never a
// credential; a store re-checks its tail on every call.
function ownerDigest(owner: KeyOwner): string {
  return createHash("sha256").update(JSON.stringify([owner.type, owner.id])).digest("base64url").slice(0, 16);
}

function encodeCursor(owner: KeyOwner, tail: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, o: ownerDigest(owner), t: tail }), "utf8").toString("base64url");
}

function cursorTail(cursor: string, owner: KeyOwner): string | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const { v, o, t } = envelope as Record<string, unknown>;
  return v === CURSOR_VERSION && o === ownerDigest(owner) && typeof t === "string" ? t : undefined;
}

/** ApiKey.List — a page of one owner's keys, oldest first; the digest is never returned. */
class List implements ResourceInstance<ListInputs, Record<string, unknown>> {
  constructor(private readonly bound: BoundKeyOperation) {}

  async invoke(inputs: ListInputs, invokeCtx?: InvokeContext): Promise<Record<string, unknown>> {
    const store = this.bound.store;
    const owner = { type: inputs.owner.type, id: inputs.owner.id };
    let after: string | undefined;
    if (inputs.cursor !== undefined) {
      after = cursorTail(inputs.cursor, owner);
      if (after === undefined) throw this.cursorInvalid();
    }
    const page = await this.bound.call(() =>
      store.list(
        { owner, limit: inputs.limit === undefined ? DEFAULT_LIMIT : Number(inputs.limit), ...(after === undefined ? {} : { after }) },
        invokeCtx,
      ),
    );
    if (page.outcome === "cursorInvalid") throw this.cursorInvalid();
    if (page.outcome !== "page") throw storeInconsistent(this.bound.describe, `${JSON.stringify(page)} for a listing`);
    return {
      keys: page.keys.map(keyRecord),
      ...(page.next === undefined ? {} : { next: encodeCursor(owner, page.next) }),
    };
  }

  private cursorInvalid(): InvokeError {
    return new InvokeError(
      ERR_API_KEY_CURSOR_INVALID,
      `${this.bound.describe}: the cursor was not returned by a listing of this owner's keys, or the store can no longer read it. Start again without a cursor.`,
    );
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<List> {
  return new List(new BoundKeyOperation("ApiKey.List", resource, ctx));
}

export function register(): void {}
