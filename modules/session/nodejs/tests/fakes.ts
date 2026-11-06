import type { KvStore, VersionedValue } from "@telorun/kv-store";
import { Sessions, type SessionsSettings } from "../src/sessions-controller.js";

export class Clock {
  now = 1_800_000_000_000;
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** An in-memory KvStore on a fake clock that counts writes per operation. */
export class CountingStore implements KvStore {
  private readonly cells = new Map<string, { value: unknown; version: number; expiresAt: number }>();
  private versions = 0;
  readonly writes: { op: string; key: string }[] = [];

  constructor(private readonly clock: Clock) {}

  private live(key: string) {
    const cell = this.cells.get(key);
    if (cell && cell.expiresAt <= this.clock.now) {
      this.cells.delete(key);
      return undefined;
    }
    return cell;
  }

  private put(key: string, value: unknown, ttlMs: number): VersionedValue {
    const version = ++this.versions;
    this.cells.set(key, { value, version, expiresAt: this.clock.now + ttlMs });
    return { value, version: String(version) };
  }

  async get(key: string) {
    const cell = this.live(key);
    return cell ? { value: cell.value, version: String(cell.version) } : null;
  }

  async putIfAbsent(key: string, value: unknown, ttlMs: number) {
    if (this.live(key)) return null;
    this.writes.push({ op: "putIfAbsent", key });
    return this.put(key, value, ttlMs);
  }

  async compareAndSet(key: string, expectedVersion: string, value: unknown, ttlMs: number) {
    const cell = this.live(key);
    if (!cell || String(cell.version) !== expectedVersion) return null;
    this.writes.push({ op: "compareAndSet", key });
    return this.put(key, value, ttlMs);
  }

  async compareAndDelete(key: string, expectedVersion: string) {
    const cell = this.live(key);
    if (!cell || String(cell.version) !== expectedVersion) return false;
    this.writes.push({ op: "compareAndDelete", key });
    this.cells.delete(key);
    return true;
  }
}

/** A store whose every conditional write loses. */
export class AlwaysConflictingStore extends CountingStore {
  reads = 0;
  async get(key: string) {
    this.reads++;
    return super.get(key);
  }
  async putIfAbsent() {
    return null;
  }
  async compareAndSet() {
    return null;
  }
  async compareAndDelete() {
    return false;
  }
}

export const SETTINGS: SessionsSettings = {
  name: "web",
  normal: { idleMs: 1_000_000, absoluteMs: 10_000_000 },
  persistent: { idleMs: 5_000_000, absoluteMs: 50_000_000 },
  maxPerSubject: 3,
};

export function principalFor(subject: string) {
  return {
    subject,
    issuer: null,
    kind: "user" as const,
    claims: {},
    scopes: ["read"],
    roles: [],
    permissions: [],
    org: null,
    amr: ["pwd"],
    acr: null,
    authenticatedAt: null,
  };
}

export function sessionsOver(store: CountingStore, clock: Clock, settings: SessionsSettings = SETTINGS) {
  return new Sessions(store, settings, 'Session.Sessions "web"', clock.read);
}
