import {
  decodeJsonValue,
  encodeJsonValue,
  parseDurationMs,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import type { KvStore, VersionedValue } from "@telorun/kv-store";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

interface StoreResource {
  metadata: { name: string; module?: string };
  url: string;
  keyPrefix?: string;
  connectTimeout?: string;
}

/** What is stored per key: the value plus its revision, in one string so a write
 *  is a single command and the two can never disagree. */
interface Cell {
  value: unknown;
  version: string;
}

/**
 * Set only if the stored revision still matches. `SET` alone cannot express the
 * condition, so it runs as a script: a client-side get-then-set would let a
 * writer whose revision is stale overwrite one a successor already published.
 *
 * Generic — it compares a revision, and knows nothing about what the value means.
 * That is the point of the store being key/value rather than protocol-shaped:
 * this one script serves every consumer.
 */
const COMPARE_AND_SET = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if cjson.decode(raw).version ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

/** Delete only if the stored revision still matches. */
const COMPARE_AND_DELETE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if cjson.decode(raw).version ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Redis-backed durable key/value store.
 *
 * `SET NX PX` gives `putIfAbsent` directly — Redis removes an expired key, so
 * "absent" and "lapsed" are the same state and NX alone is the whole condition.
 * The two compare-and-* operations are Lua so the comparison and the write are
 * one atomic step.
 *
 * Redis key expiry implements the TTLs, and only those. Configure the server
 * WITHOUT a policy that can drop live keys (`maxmemory-policy noeviction`): under
 * `allkeys-lru` a record can vanish before its TTL, and this store's entire
 * purpose is that it does not.
 */
class RedisKvStore implements ResourceInstance, KvStore {
  private readonly client: Redis;
  private readonly prefix: string;

  constructor(resource: StoreResource) {
    this.prefix = resource.keyPrefix ?? "telo:kv:";
    this.client = new Redis(resource.url, {
      connectTimeout: parseDurationMs(resource.connectTimeout, 2000),
      // Fail loudly rather than queueing forever: a caller must never block
      // indefinitely waiting to learn whether its conditional write landed.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async init(): Promise<void> {
    await this.client.connect();
  }

  async get(key: string): Promise<VersionedValue | null> {
    const raw = await this.client.get(this.key(key));
    if (!raw) return null;
    const cell = decodeJsonValue(raw) as Cell;
    return { value: cell.value, version: cell.version };
  }

  async putIfAbsent(key: string, value: unknown, ttlMs: number): Promise<VersionedValue | null> {
    const version = randomUUID();
    const cell: Cell = { value, version };
    const won = await this.client.set(
      this.key(key),
      encodeJsonValue(cell),
      "PX",
      ttlMs,
      "NX",
    );
    return won ? { value, version } : null;
  }

  async compareAndSet(
    key: string,
    expectedVersion: string,
    value: unknown,
    ttlMs: number,
  ): Promise<VersionedValue | null> {
    const version = randomUUID();
    const res = await this.client.eval(
      COMPARE_AND_SET,
      1,
      this.key(key),
      expectedVersion,
      encodeJsonValue({ value, version } satisfies Cell),
      String(ttlMs),
    );
    return res === 1 ? { value, version } : null;
  }

  async compareAndDelete(key: string, expectedVersion: string): Promise<boolean> {
    const res = await this.client.eval(COMPARE_AND_DELETE, 1, this.key(key), expectedVersion);
    return res === 1;
  }

  async provide(): Promise<RedisKvStore> {
    return this;
  }

  async teardown(): Promise<void> {
    await this.client.quit();
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const store = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: StoreResource, _ctx: ResourceContext) {
    return new RedisKvStore(resource);
  },
};
