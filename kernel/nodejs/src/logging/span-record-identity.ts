/**
 * The trace identity a record emitted right now carries, when the emitter names
 * it rather than the ambient dispatch doing so.
 *
 * `Telo.LogTraceSink` writes a finished span as a record, and that record is the
 * span's own: it carries the span's trace and span ids, so it sits beside the
 * records emitted inside the span. The ambient context at that moment is the
 * span's PARENT (a span ends after its work has left the scope it opened), so
 * automatic attachment would name the wrong span.
 *
 * A plain variable rather than an async store: building a record is synchronous,
 * so the identity is set only for the duration of one `log()` call.
 */

export interface RecordTraceIdentity {
  traceId: string;
  spanId: string;
}

let current: RecordTraceIdentity | undefined;

export function withRecordTraceIdentity(identity: RecordTraceIdentity, emit: () => void): void {
  const previous = current;
  current = identity;
  try {
    emit();
  } finally {
    current = previous;
  }
}

export function explicitRecordTraceIdentity(): RecordTraceIdentity | undefined {
  return current;
}
