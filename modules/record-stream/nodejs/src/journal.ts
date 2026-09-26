/**
 * The journal protocol — written once, over any {@link JournalStore}. Claims,
 * heartbeats, terminal states, removal markers, expiry, the stale-writer rule
 * and every state a reader is told live here and nowhere else; a store holds
 * opaque headers and records and knows none of them.
 */
import { randomUUID } from "node:crypto";
import {
  type CancellationToken,
  ERR_INVOKE_CANCELLED,
  InvokeError,
  createCancellationSource,
  decodeTypedFrame,
  encodeTypedFrame,
  isInvokeError,
  withoutAbsentMembers,
} from "@telorun/sdk";
import type { JournalHeader, JournalPage, JournalStore, JournalStoreEntry } from "./journal-store-contract.js";
import { type RecordedError, recordedError } from "./recorded-error.js";

export const ERR_JOURNAL_KEY_BUSY = "ERR_JOURNAL_KEY_BUSY";
export const ERR_JOURNAL_KEY_REMOVED = "ERR_JOURNAL_KEY_REMOVED";
export const ERR_JOURNAL_WRITER_LOST = "ERR_JOURNAL_WRITER_LOST";

/** Entries fetched per store read. */
const PAGE_SIZE = 256;
/** Headers fetched per expiry scan call. */
const SCAN_SIZE = 256;

/** One journaled record: its 1-based, gap-free id and its data. */
export interface JournalEntry {
  id: number;
  data: unknown;
}

/** The header the protocol keeps per key, typed-frame encoded in the store. */
type KeyState =
  | { state: "open"; holder: string; timeoutMs: number }
  | { state: "finished"; holder: string }
  | { state: "failed"; holder: string; error: RecordedError; writerLost: boolean }
  | { state: "removed" };

function encodeState(state: KeyState): string {
  return encodeTypedFrame(state);
}

function decodeState(header: JournalHeader): KeyState {
  return decodeTypedFrame(header.value) as KeyState;
}

/** The recorded error as a reader receives it: coded when it was recorded with a
 *  code, so a replay after a restart still carries it. */
function replayError(error: RecordedError): Error {
  return error.code === undefined ? new Error(error.message) : new InvokeError(error.code, error.message, error.data);
}

function lost(key: string): InvokeError {
  return new InvokeError(
    ERR_JOURNAL_WRITER_LOST,
    `RecordStream.Journal: the writer of key '${key}' stopped sending heartbeats within its timeout, so the key was failed.`,
    { key },
  );
}

function removed(key: string): InvokeError {
  return new InvokeError(ERR_JOURNAL_KEY_REMOVED, `RecordStream.Journal: key '${key}' was removed.`, { key });
}

function busy(key: string): InvokeError {
  return new InvokeError(
    ERR_JOURNAL_KEY_BUSY,
    `RecordStream.Journal: key '${key}' is already written by another writer.`,
    { key },
  );
}

export interface JournalSettings {
  retentionMs: number;
  writerTimeoutMs: number;
}

export abstract class Journal {
  constructor(readonly settings: JournalSettings) {}

  /** The store this journal runs over. */
  protected abstract get store(): JournalStore;

  private async header(key: string): Promise<JournalHeader | null> {
    return (await this.store.read(key, 0, 0)).header;
  }

  /**
   * Claim `key` for one writer. An existing key is refused — removed for a
   * marker, busy otherwise — unless `resume` is set: then a failed key, or an
   * open one whose writer went stale (failed as lost first, at the version that
   * was read), is taken over. A takeover keeps the log, so appends continue from
   * its last id; a live writer's key and a finished key stay busy.
   */
  async claim(key: string, options: { resume?: boolean } = {}): Promise<JournalWriter> {
    const holder = randomUUID();
    const open = encodeState({ state: "open", holder, timeoutMs: this.settings.writerTimeoutMs });
    while (true) {
      const version = await this.store.putIfAbsent(key, open);
      if (version !== null) return new JournalWriter(this.store, key, holder, open, version);
      const header = await this.header(key);
      // Deleted between the two calls: the key is free again.
      if (!header) continue;
      const state = decodeState(header);
      if (state.state === "removed") throw removed(key);
      if (!options.resume || state.state === "finished") throw busy(key);
      let failedAt: string | null = header.version;
      if (state.state === "open") {
        if (header.ageMs <= state.timeoutMs) throw busy(key);
        failedAt = await this.failLost(key, header.version, state.holder);
        // The writer moved in the meantime: judge the key again.
        if (failedAt === null) continue;
      }
      const taken = await this.store.compareAndSet(key, failedAt, open);
      if (taken !== null) return new JournalWriter(this.store, key, holder, open, taken);
    }
  }

  /** Fail an open key as abandoned by `holder`, at `version`. Null when the key
   *  moved since that version was read. */
  private failLost(key: string, version: string, holder: string): Promise<string | null> {
    const failed: KeyState = {
      state: "failed",
      holder,
      error: { code: ERR_JOURNAL_WRITER_LOST, message: lost(key).message, data: { key } },
      writerLost: true,
    };
    return this.store.compareAndSet(key, version, encodeState(failed));
  }

  /**
   * Fail an open key whose writer's heartbeat is older than the timeout the
   * writer recorded, at the version that was read — so a live writer's touch or
   * append in the meantime makes this lose. Returns the milliseconds until the
   * key could next go stale, or 0 when it is not open (or just stopped being).
   */
  private async checkStale(key: string, header: JournalHeader, state: KeyState): Promise<number> {
    if (state.state !== "open") return 0;
    if (header.ageMs <= state.timeoutMs) return state.timeoutMs - header.ageMs;
    await this.failLost(key, header.version, state.holder);
    return 0;
  }

  /**
   * Open `key` for reading from `fromId`. A key removed at open is refused here,
   * before any stream exists, so a caller's catch list can map it. The stream
   * ends when its consumer stops, and raises `ERR_INVOKE_CANCELLED` when
   * `cancellation` — the producing invocation's — is cancelled.
   */
  async open(key: string, fromId: number, cancellation: CancellationToken): Promise<JournalReader> {
    const first = await this.store.read(key, fromId, PAGE_SIZE);
    if (first.header && decodeState(first.header).state === "removed") throw removed(key);
    return new JournalReader(
      {
        store: this.store,
        writerTimeoutMs: this.settings.writerTimeoutMs,
        checkStale: (header, state) => this.checkStale(key, header, state),
      },
      key,
      fromId,
      first,
      cancellation,
    );
  }

  /** Remove `key`: its records are dropped and a marker left, so it reads as
   *  removed rather than unknown. */
  async remove(key: string): Promise<"removed" | "unknown"> {
    while (true) {
      const header = await this.header(key);
      if (!header) return "unknown";
      if (decodeState(header).state === "removed") return "removed";
      const marker: KeyState = { state: "removed" };
      if ((await this.store.compareAndTruncate(key, header.version, encodeState(marker))) !== null) {
        return "removed";
      }
    }
  }

  /**
   * One expiry pass: dead writers' keys are failed, finished and failed keys
   * past retention become markers, and markers past retention are deleted.
   * Returns how many terminal keys had their records removed.
   */
  async expire(): Promise<number> {
    const { retentionMs, writerTimeoutMs } = this.settings;
    const marker = encodeState({ state: "removed" });
    let count = 0;
    let cursor: string | null = null;
    do {
      const scan = await this.store.scan(Math.min(retentionMs, writerTimeoutMs), cursor, SCAN_SIZE);
      for (const header of scan.headers) {
        const state = decodeState(header);
        if (state.state === "open") {
          await this.checkStale(header.key, header, state);
        } else if (header.ageMs < retentionMs) {
          continue;
        } else if (state.state === "removed") {
          await this.store.compareAndDelete(header.key, header.version);
        } else if ((await this.store.compareAndTruncate(header.key, header.version, marker)) !== null) {
          count++;
        }
      }
      cursor = scan.cursor;
    } while (cursor !== null);
    return count;
  }
}

/**
 * A claimed key. Every write presents the version the previous one returned, so
 * the caller must not run two of them at once.
 */
export class JournalWriter {
  constructor(
    private readonly store: JournalStore,
    readonly key: string,
    private readonly holder: string,
    private readonly openValue: string,
    private version: string,
  ) {}

  /** Why a write at our version was refused. */
  private async refusal(): Promise<Error> {
    const header = (await this.store.read(this.key, 0, 0)).header;
    if (!header) return removed(this.key);
    const state = decodeState(header);
    if (state.state === "removed") return removed(this.key);
    if (state.holder !== this.holder) return busy(this.key);
    if (state.state === "failed" && state.writerLost) return lost(this.key);
    return new Error(
      `RecordStream.Journal: the store refused a write to key '${this.key}' by its own holder while the key is ${state.state}; the store reported a conflict no other writer caused.`,
    );
  }

  async append(data: unknown): Promise<number> {
    const record = encodeTypedFrame(withoutAbsentMembers(data));
    const result = await this.store.compareAndAppend(this.key, this.version, record);
    if (!result) throw await this.refusal();
    this.version = result.version;
    return result.id;
  }

  /** The heartbeat: rewrite the same header, so its age restarts. */
  async touch(): Promise<void> {
    const version = await this.store.compareAndSet(this.key, this.version, this.openValue);
    if (version === null) throw await this.refusal();
    this.version = version;
  }

  async finish(): Promise<void> {
    await this.settle({ state: "finished", holder: this.holder });
  }

  /**
   * Record the drain's failure. An error whose `data` is outside the CEL value
   * domain is recorded with its code and message only; the returned note says so,
   * for the caller to report.
   */
  async fail(err: unknown): Promise<{ dataNotRecorded?: string }> {
    const error = recordedError(err);
    const failed = (recorded: RecordedError): KeyState => ({
      state: "failed",
      holder: this.holder,
      error: recorded,
      writerLost: false,
    });
    let state = failed(error);
    let note: { dataNotRecorded?: string } = {};
    if (error.data !== undefined) {
      try {
        encodeState(state);
      } catch (encodeErr) {
        if (!isInvokeError(encodeErr) || encodeErr.code !== "ERR_TYPED_FRAME_UNENCODABLE") throw encodeErr;
        const { data, ...withoutData } = error;
        state = failed(withoutData);
        note = { dataNotRecorded: encodeErr.message };
      }
    }
    await this.settle(state);
    return note;
  }

  private async settle(state: KeyState): Promise<void> {
    const version = await this.store.compareAndSet(this.key, this.version, encodeState(state));
    if (version === null) throw await this.refusal();
    this.version = version;
  }
}

interface ReaderAccess {
  store: JournalStore;
  writerTimeoutMs: number;
  checkStale(header: JournalHeader, state: KeyState): Promise<number>;
}

const DONE: IteratorResult<JournalEntry> = { value: undefined, done: true };

/**
 * One reader of one key: replays from an offset, then does what the key's
 * state says. An iterator rather than an async generator, because a generator's
 * `return()` waits for a pending `next()` — here `return()` ends the reader at
 * once, even while it waits on the store, and that pending `next()` ends too
 * without another store call. Its own cancellation is tripped by the consumer
 * stopping and by the producing invocation's cancellation.
 */
export class JournalReader implements AsyncIterableIterator<JournalEntry> {
  private readonly source = createCancellationSource();
  private readonly unlink: () => void;
  private invocationCancelled: string | undefined;
  private ended = false;
  private queue: Promise<unknown> = Promise.resolve();
  private cursor: number;
  private seen = false;
  private buffered: JournalStoreEntry[] = [];
  /** What follows the buffered entries: a fresh page, the end, a failure, or a tail. */
  private after:
    | { kind: "page"; page: JournalPage | null }
    | { kind: "end" }
    | { kind: "raise"; error: Error }
    | { kind: "tail"; header: JournalHeader; state: KeyState };

  constructor(
    private readonly access: ReaderAccess,
    private readonly key: string,
    fromId: number,
    first: JournalPage,
    invocation: CancellationToken,
  ) {
    this.cursor = fromId;
    this.after = { kind: "page", page: first };
    this.unlink = invocation.onCancelled((reason) => {
      this.invocationCancelled = reason ?? "Invoke cancelled";
      this.source.cancel(reason);
    });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<JournalEntry>> {
    const step = this.queue.then(() => this.step());
    this.queue = step.then(
      () => undefined,
      () => undefined,
    );
    return step;
  }

  /** The consumer stopped: end now, whatever is pending. */
  async return(): Promise<IteratorResult<JournalEntry>> {
    // Cancel before ending: ending disposes the source, dropping its listeners.
    this.source.cancel("the stream's consumer stopped");
    this.end();
    return DONE;
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.unlink();
    this.source.dispose();
  }

  /** Throws when the producing invocation was cancelled; true when the reader ended. */
  private stopped(): boolean {
    if (this.invocationCancelled !== undefined && !this.ended) {
      const reason = this.invocationCancelled;
      this.end();
      throw new InvokeError(ERR_INVOKE_CANCELLED, `RecordStream.Journal: reading key '${this.key}' was cancelled (${reason}).`, {
        key: this.key,
      });
    }
    return this.ended;
  }

  private async step(): Promise<IteratorResult<JournalEntry>> {
    const { store } = this.access;
    const token = this.source.token;
    try {
      while (true) {
        if (this.stopped()) return DONE;
        const entry = this.buffered.shift();
        if (entry) {
          this.cursor = entry.id;
          return { value: { id: entry.id, data: decodeTypedFrame(entry.record) }, done: false };
        }
        const after = this.after;
        if (after.kind === "end") {
          this.end();
          return DONE;
        }
        if (after.kind === "raise") throw after.error;
        if (after.kind === "tail") {
          const remainingMs = await this.access.checkStale(after.header, after.state);
          if (this.stopped()) return DONE;
          if (remainingMs > 0) await store.wait(this.key, after.header.version, remainingMs, token);
          this.after = { kind: "page", page: null };
          continue;
        }
        const page = after.page ?? (await store.read(this.key, this.cursor, PAGE_SIZE));
        if (this.stopped()) return DONE;
        this.accept(page);
        if (this.after.kind === "page" && this.after.page === null && !page.header) {
          await store.wait(this.key, null, this.access.writerTimeoutMs, token);
        }
      }
    } catch (err) {
      this.end();
      throw err;
    }
  }

  /** Take one page: buffer its entries and decide what follows them. */
  private accept(page: JournalPage): void {
    const header = page.header;
    if (!header) {
      // Once a key has been seen, reading it as unknown means it was expired
      // under the reader — never a short replay presented as finished.
      if (this.seen) throw removed(this.key);
      this.after = { kind: "page", page: null };
      return;
    }
    this.seen = true;
    const state = decodeState(header);
    if (state.state === "removed") throw removed(this.key);
    this.buffered = page.entries;
    if (page.entries.length === PAGE_SIZE) this.after = { kind: "page", page: null };
    else if (state.state === "finished") this.after = { kind: "end" };
    else if (state.state === "failed") this.after = { kind: "raise", error: replayError(state.error) };
    else this.after = { kind: "tail", header, state };
  }
}

/** Duck-typed: a journal handed across a module boundary is still a journal. */
export function isJournal(value: unknown): value is Journal {
  const j = value as Partial<Journal> | undefined;
  return (
    typeof j?.claim === "function" &&
    typeof j.open === "function" &&
    typeof j.remove === "function" &&
    typeof j.expire === "function"
  );
}
