import {
  celDurationFromNanos,
  durationNanos,
  isCelDuration,
  InvokeError,
  type KindRef,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { Journal, type JournalSettings } from "./journal.js";
import { type JournalStore, isJournalStore } from "./journal-store-contract.js";

/** A duration is nanosecond-precise and carries no methods — it is identified by a type
 *  key, not by a class — so milliseconds are read off its total and built back from one. */
const NANOS_PER_MILLISECOND = 1_000_000n;

/** The writer timeout a journal applies when `writerTimeout:` is omitted. */
const DEFAULT_WRITER_TIMEOUT_MS = 30_000;

interface JournalResource {
  metadata: { name: string; module?: string };
  store?: JournalStore | KindRef<JournalStore>;
  retention?: unknown;
  markerRetention?: unknown;
  writerTimeout?: unknown;
}

function milliseconds(value: unknown, field: string, label: string): number {
  if (!isCelDuration(value)) {
    throw new InvokeError("ERR_INVALID_VALUE", `${label}: '${field}' must be a duration.`);
  }
  return Number(durationNanos(value) / NANOS_PER_MILLISECOND);
}

/** A retention field in milliseconds; undefined when omitted. */
function retentionMilliseconds(value: unknown, field: string, code: string, label: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = milliseconds(value, field, label);
  if (ms < 0) throw new InvokeError(code, `${code}: ${label} sets a negative '${field}'.`);
  return ms;
}

/**
 * RecordStream.Journal — the journal protocol over a configured store. Its
 * instance IS the {@link Journal}; sinks, sources, removal and expiry reach the
 * store only through it.
 */
class JournalProvider extends Journal implements ResourceInstance {
  private resolved: JournalStore | undefined;

  constructor(
    private readonly resource: JournalResource,
    private readonly label: string,
    settings: JournalSettings,
  ) {
    super(settings);
  }

  protected get store(): JournalStore {
    if (!this.resolved) throw new Error(`${this.label} was used before it was initialized.`);
    return this.resolved;
  }

  init(ctx: ResourceContext): void {
    this.resolved = ctx.resolveRef(this.resource.store, isJournalStore, () => `${this.label}: 'store'`, "Self.JournalStore");
  }

  async provide(): Promise<Journal> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    const { retentionMs, markerRetentionMs, writerTimeoutMs } = this.settings;
    return {
      ...(retentionMs === undefined ? {} : { retention: celDurationFromNanos(BigInt(retentionMs) * NANOS_PER_MILLISECOND) }),
      markerRetention: celDurationFromNanos(BigInt(markerRetentionMs) * NANOS_PER_MILLISECOND),
      writerTimeout: celDurationFromNanos(BigInt(writerTimeoutMs) * NANOS_PER_MILLISECOND),
    };
  }
}

export function register(): void {}

export async function create(resource: JournalResource): Promise<JournalProvider> {
  const label = `RecordStream.Journal "${resource.metadata.name}"`;
  const retentionMs = retentionMilliseconds(resource.retention, "retention", "RECORD_STREAM_RETENTION_NEGATIVE", label);
  const markerRetentionMs =
    retentionMilliseconds(
      resource.markerRetention,
      "markerRetention",
      "RECORD_STREAM_MARKER_RETENTION_NEGATIVE",
      label,
    ) ?? retentionMs;
  if (markerRetentionMs === undefined) {
    throw new InvokeError(
      "RECORD_STREAM_RETENTION_MISSING",
      `RECORD_STREAM_RETENTION_MISSING: ${label} sets neither 'retention' nor 'markerRetention', so a removal marker would be kept forever.`,
    );
  }
  const writerTimeoutMs =
    resource.writerTimeout === undefined
      ? DEFAULT_WRITER_TIMEOUT_MS
      : milliseconds(resource.writerTimeout, "writerTimeout", label);
  if (writerTimeoutMs <= 0) {
    throw new InvokeError(
      "RECORD_STREAM_WRITER_TIMEOUT_NOT_POSITIVE",
      `RECORD_STREAM_WRITER_TIMEOUT_NOT_POSITIVE: ${label} sets 'writerTimeout' to zero or less.`,
    );
  }
  return new JournalProvider(resource, label, { retentionMs, markerRetentionMs, writerTimeoutMs });
}
