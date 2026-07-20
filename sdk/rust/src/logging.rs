//! Structured logging — the Rust half of `kernel/specs/logging.md`.
//!
//! The same crate serves two roles, gated by the existing Cargo features:
//!
//! * `native` — a **host** runtime. The logger is a full implementation: it owns
//!   the threshold, builds records, and hands them to a sink.
//! * `napi` — a **guest** across an FFI boundary into today's Node.js kernel.
//!   §9 governs there: the threshold is cached guest-side as a plain atomic,
//!   `enabled()` never crosses the boundary, and a suppressed record is never
//!   serialized.
//!
//! Both share this surface, so a controller's logging code compiles unchanged
//! against either.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};

use serde_json::{Map, Value};

/// OTel `SeverityNumber` (1–24). `0` (UNSPECIFIED) is never emitted.
pub type SeverityNumber = i64;

/// The six levels Telo names. Each is the floor of its four-value OTel range.
pub mod severity {
    use super::SeverityNumber;

    pub const TRACE: SeverityNumber = 1;
    pub const DEBUG: SeverityNumber = 5;
    pub const INFO: SeverityNumber = 9;
    pub const WARN: SeverityNumber = 13;
    pub const ERROR: SeverityNumber = 17;
    pub const FATAL: SeverityNumber = 21;
}

/// A record at or above this severity describes an error (§5.1).
pub const ERROR_SEVERITY_FLOOR: SeverityNumber = 17;

const FLOORS: [SeverityNumber; 6] = [1, 5, 9, 13, 17, 21];

/// The canonical level a severity maps onto. Out-of-range values clamp into
/// 1–24 rather than producing `0`, which §5.1 forbids emitting.
pub fn severity_floor(severity: SeverityNumber) -> SeverityNumber {
    let clamped = severity.clamp(1, 24);
    let mut floor = FLOORS[0];
    for candidate in FLOORS {
        if candidate <= clamped {
            floor = candidate;
        } else {
            break;
        }
    }
    floor
}

/// Canonical short name (`TRACE`…`FATAL`) for a severity number.
pub fn severity_text(severity: SeverityNumber) -> &'static str {
    match severity_floor(severity) {
        1 => "TRACE",
        5 => "DEBUG",
        9 => "INFO",
        13 => "WARN",
        17 => "ERROR",
        _ => "FATAL",
    }
}

/// `tracing` has no FATAL and orders its levels *inversely* — `ERROR` is the
/// lowest. §5.2 forbids propagating that ordering into the record model: FATAL
/// maps onto `tracing::Level::ERROR` for emission while the record still
/// carries `severity_number: 21`, so no severity is lost on the Telo side.
pub fn tracing_level_name(severity: SeverityNumber) -> &'static str {
    match severity_floor(severity) {
        1 => "TRACE",
        5 => "DEBUG",
        9 => "INFO",
        13 => "WARN",
        // Both ERROR and FATAL render as tracing's ERROR.
        _ => "ERROR",
    }
}

/// A log record in the §4 model. `message` is a string, not OTel's structured
/// `Body` — structured data goes in `attributes` (D4).
///
/// `timestamp` is REQUIRED (§4): nanoseconds since the Unix epoch, by the origin
/// clock. A host runtime (the `native` backend) stamps it when the record is
/// built; a guest (the `napi` backend) may leave it `0` and let the host stamp
/// it on the far side of the boundary, since the guest's clock is not the origin
/// for a record the host owns. `0` therefore means "unstamped", never a real
/// 1970 instant, and an encoder treats it as "stamp me".
#[derive(Debug, Clone, Default)]
pub struct LogRecord {
    /// Nanoseconds since the Unix epoch. See the struct doc for the `0` sentinel.
    pub timestamp: u64,
    /// When the runtime observed the event, if it differs from `timestamp` — set
    /// by a bridge, whose source timestamp is the origin time (§13.3).
    pub observed_timestamp: Option<u64>,
    pub severity_number: SeverityNumber,
    pub severity_text: String,
    pub message: String,
    pub attributes: Map<String, Value>,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    /// Bit 0 = sampled; bit 1 reserved (§7.5).
    pub trace_flags: Option<u8>,
    pub resource: Option<ResourceRef>,
    pub module: Option<String>,
    /// Dotted import-alias path identifying which instance emitted the record.
    pub scope: Option<String>,
    /// Identifies a class of event; max 256 chars.
    pub event_name: Option<String>,
    pub error: Option<ErrorValue>,
    /// Non-zero when §6.3 limits truncated attributes.
    pub dropped_attributes_count: Option<u32>,
}

/// The emitting Telo resource (§7.3). `id` is the full hierarchical id.
#[derive(Debug, Clone, Default)]
pub struct ResourceRef {
    pub kind: String,
    pub name: String,
    pub id: Option<String>,
}

/// Structured error (§4.2). The `cause` chain is bounded per §6.3.
#[derive(Debug, Clone, Default)]
pub struct ErrorValue {
    /// Error class or code, e.g. `ERR_INVOKE_CANCELLED`.
    pub error_type: String,
    pub message: String,
    /// Multi-line, unmodified.
    pub stack: Option<String>,
    pub cause: Option<Box<ErrorValue>>,
}

/// Per-record extras that are top-level record fields rather than attributes —
/// kept out of the attribute map so they cannot collide with a reserved key.
/// The producer-side counterpart of the Node SDK's `LogOptions`, so a Rust
/// controller can emit a structured error or an `event_name`, both of which the
/// shared record schema defines as first-class.
#[derive(Debug, Clone, Default)]
pub struct LogOptions {
    pub error: Option<ErrorValue>,
    pub event_name: Option<String>,
    /// The event's origin time, when earlier than the moment `log` was called —
    /// set by a bridge, which also stamps `observed_timestamp` (§13.3).
    pub timestamp: Option<u64>,
    /// The original source spelling of the level, preserved when bridging a
    /// level Telo does not name (§5.1).
    pub severity_text: Option<String>,
}

/// Wall-clock nanoseconds since the Unix epoch, for a host runtime to stamp a
/// record with. `SystemTime` is millisecond-to-nanosecond depending on platform;
/// the value is always epoch-anchored, unlike a monotonic clock.
pub fn now_unix_nanos() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Where a host-side logger writes. The `native` backend supplies one; under
/// `napi` the sink forwards across the FFI boundary.
pub trait LogSink: Send + Sync {
    fn write(&self, record: LogRecord);
    fn flush(&self) {}
}

/// The threshold cache §9 requires.
///
/// The value is the **already-resolved** threshold for this controller's module
/// context (§12.2), not the root default: scope resolution happens once when the
/// import graph is built, so a guest never evaluates cascade rules and never
/// walks an import chain at emit time. Pushing a resolved scalar is the whole
/// mechanism — there is nothing further to interpret on this side.
///
/// The host pushes changes on reconfiguration (§12.4); a guest never polls.
#[derive(Debug)]
pub struct ThresholdCache(AtomicI64);

impl ThresholdCache {
    pub fn new(threshold: SeverityNumber) -> Self {
        Self(AtomicI64::new(threshold))
    }

    /// Resolves entirely guest-side; never crosses the FFI boundary.
    #[inline]
    pub fn enabled(&self, severity: SeverityNumber) -> bool {
        severity >= self.0.load(Ordering::Relaxed)
    }

    /// Called by the host when configuration changes.
    pub fn set(&self, threshold: SeverityNumber) {
        self.0.store(threshold, Ordering::Relaxed);
    }

    pub fn get(&self) -> SeverityNumber {
        self.0.load(Ordering::Relaxed)
    }
}

/// The logger handed to a controller.
///
/// **Scope.** This is the producer surface: threshold gating, record building,
/// and child-logger binding. The §6.3 attribute limits, §14 redaction, and §15
/// sampling are **pipeline stages the host applies** after a record is created
/// (§10.1: threshold → redaction → sampling → fan-out), not producer
/// responsibilities — a guest (§9) never runs them, and the `native` host runs
/// them in its sink pipeline. So a `LogRecord` this logger emits is a conformant
/// §4 record; enforcing the limits and redaction is the host pipeline's job,
/// exactly as it is on the Node.js side.
///
/// **Deliberately not `Clone`.** §9 requires that a logger handle obtained
/// during a call is not retained beyond that call, and the type system is the
/// place to enforce it where the language allows — the same reasoning that keeps
/// `CancellationToken` un-`Clone`able. A controller that stashes a `Logger` in
/// its struct would hold a handle whose backing host object is gone.
pub struct Logger {
    threshold: Arc<ThresholdCache>,
    sink: Arc<dyn LogSink>,
    bound: Map<String, Value>,
}

impl Logger {
    pub fn new(threshold: Arc<ThresholdCache>, sink: Arc<dyn LogSink>) -> Self {
        Self {
            threshold,
            sink,
            bound: Map::new(),
        }
    }

    /// The load-bearing performance primitive. Never blocks, never throws, and
    /// resolves without crossing the FFI boundary.
    ///
    /// The result is **not static** — it changes when the host pushes a new
    /// threshold, so callers re-check per emission rather than caching it.
    #[inline]
    pub fn enabled(&self, severity: SeverityNumber) -> bool {
        self.threshold.enabled(severity)
    }

    /// Emit a record. A suppressed record is never built, never serialized, and
    /// never crosses the boundary (§9.3).
    pub fn log(&self, severity: SeverityNumber, message: &str, attributes: Map<String, Value>) {
        self.log_with(severity, message, attributes, LogOptions::default());
    }

    /// Emit a record carrying per-record extras — a structured error, an
    /// `event_name`, or a bridged origin timestamp (§4.2, §13.3). The Rust
    /// counterpart of the Node SDK's optional `LogOptions` argument, so the two
    /// producer surfaces can emit the same record shape.
    pub fn log_with(
        &self,
        severity: SeverityNumber,
        message: &str,
        attributes: Map<String, Value>,
        options: LogOptions,
    ) {
        if !self.enabled(severity) {
            return;
        }
        let mut merged = self.bound.clone();
        // Record attributes override bound attributes (§8.3).
        for (key, value) in attributes {
            merged.insert(key, value);
        }
        // A bridged record's origin time precedes the moment the runtime saw it.
        let observed_timestamp = options.timestamp.map(|_| now_unix_nanos());
        self.sink.write(LogRecord {
            timestamp: options.timestamp.unwrap_or_else(now_unix_nanos),
            observed_timestamp,
            severity_number: severity,
            severity_text: options
                .severity_text
                .unwrap_or_else(|| severity_text(severity).to_string()),
            message: message.to_string(),
            attributes: merged,
            event_name: options.event_name,
            error: options.error,
            ..LogRecord::default()
        });
    }

    /// A child logger whose bound attributes merge into every record. The merge
    /// happens once here, never per record (§8.3).
    pub fn with(&self, attributes: Map<String, Value>) -> Logger {
        let mut bound = self.bound.clone();
        for (key, value) in attributes {
            bound.insert(key, value);
        }
        Logger {
            threshold: Arc::clone(&self.threshold),
            sink: Arc::clone(&self.sink),
            bound,
        }
    }

    pub fn flush(&self) {
        self.sink.flush();
    }

    pub fn trace(&self, message: &str) {
        self.log(severity::TRACE, message, Map::new());
    }
    pub fn debug(&self, message: &str) {
        self.log(severity::DEBUG, message, Map::new());
    }
    pub fn info(&self, message: &str) {
        self.log(severity::INFO, message, Map::new());
    }
    pub fn warn(&self, message: &str) {
        self.log(severity::WARN, message, Map::new());
    }
    pub fn error(&self, message: &str) {
        self.log(severity::ERROR, message, Map::new());
    }
    /// Severity never implies control flow (D5): this does not exit, panic, or
    /// alter control flow. It triggers an immediate flush.
    pub fn fatal(&self, message: &str) {
        self.log(severity::FATAL, message, Map::new());
        self.flush();
    }
}

/// An 8-byte per-process salt, minted once. §7.1 (D7) makes salting **normative**
/// ("Runtimes MUST therefore XOR the counter with an 8-byte per-process random
/// salt … and emit that"), so this is not a Node-only detail: a bare counter
/// starting at 1 collides across processes in one distributed trace, and the
/// emitted span id must be the salted form on every runtime.
static SPAN_ID_SALT: OnceLock<u64> = OnceLock::new();

fn span_id_salt() -> u64 {
    // Derived from the address of a per-process allocation plus the process id,
    // hashed — enough entropy to make two independently-started processes mint
    // different salts, without pulling in a random-number crate. A host with a
    // CSPRNG available SHOULD seed this from it instead.
    *SPAN_ID_SALT.get_or_init(|| {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        std::process::id().hash(&mut hasher);
        (Box::into_raw(Box::new(0u8)) as usize).hash(&mut hasher);
        now_unix_nanos().hash(&mut hasher);
        hasher.finish()
    })
}

/// Apply the process salt to a raw counter. Bijective, so uniqueness within the
/// process is preserved exactly. Mirrors the Node SDK's `saltSpanId`.
pub fn salt_span_id(counter: u64) -> u64 {
    counter ^ span_id_salt()
}

/// Render the salted form of a raw counter — the two steps a record emission
/// performs together (§7.1). Mirrors the Node SDK's `formatSpanCounter`, so two
/// runtimes agree on the emitted id for a given internal counter under the same
/// salt.
pub fn format_span_counter(counter: u64) -> Option<String> {
    format_span_id(salt_span_id(counter))
}

/// Render a span id as exactly 16 lowercase hex characters (§7.1).
///
/// Zero-padding is enforced here because it is a live bug class: in Rust,
/// `opentelemetry`'s `LowerHex` impl for `TraceId` delegates to `u128` **without
/// a width**, so `format!("{:x}", id)` silently produces a short, spec-invalid
/// id whenever the value has leading zero bytes. Always use a width, or the
/// `Display` impl — never a bare `{:x}`.
///
/// An all-zero id is invalid and is treated as absent rather than emitted. This
/// is the raw formatter; a runtime minting an id from a counter calls
/// {@link format_span_counter}, which salts first.
pub fn format_span_id(value: u64) -> Option<String> {
    if value == 0 {
        return None;
    }
    Some(format!("{value:016x}"))
}

/// Render a trace id as exactly 32 lowercase hex characters (§7.1).
pub fn format_trace_id(value: u128) -> Option<String> {
    if value == 0 {
        return None;
    }
    Some(format!("{value:032x}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct CollectingSink(Mutex<Vec<LogRecord>>);

    impl LogSink for CollectingSink {
        fn write(&self, record: LogRecord) {
            self.0.lock().unwrap().push(record);
        }
    }

    /// Vector 1 — severity round-trip.
    #[test]
    fn severity_round_trip() {
        assert_eq!(severity_text(severity::TRACE), "TRACE");
        assert_eq!(severity_text(severity::FATAL), "FATAL");
        // An unmappable source level lands on its range floor.
        assert_eq!(severity_floor(7), severity::DEBUG);
        // Never 0, which §5.1 forbids emitting.
        assert_eq!(severity_floor(0), severity::TRACE);
        assert_eq!(severity_floor(99), severity::FATAL);
    }

    /// Vector 2 — the Go offset holds for all six levels.
    #[test]
    fn slog_offset() {
        for (severity, slog) in [
            (severity::TRACE, -8),
            (severity::DEBUG, -4),
            (severity::INFO, 0),
            (severity::WARN, 4),
            (severity::ERROR, 8),
            (severity::FATAL, 12),
        ] {
            assert_eq!(severity - 9, slog);
        }
    }

    /// §5.2 — FATAL renders as tracing's ERROR without losing the severity.
    #[test]
    fn fatal_maps_to_tracing_error() {
        assert_eq!(tracing_level_name(severity::FATAL), "ERROR");
        assert_eq!(severity_floor(severity::FATAL), 21);
    }

    /// Vector 3 — id formatting is zero-padded, and an all-zero id is omitted.
    #[test]
    fn id_formatting() {
        assert_eq!(format_span_id(1).unwrap(), "0000000000000001");
        assert!(format_span_id(0).is_none());
        assert_eq!(format_span_id(u64::MAX).unwrap().len(), 16);
        assert_eq!(format_trace_id(1).unwrap().len(), 32);
        assert!(format_trace_id(0).is_none());
    }

    /// Vector 4 — span id salting (§7.1 D7, normative). The emitted id is the
    /// salted counter, not the bare one, and salting is bijective so distinct
    /// counters stay distinct. Mirrors the Node SDK exactly.
    #[test]
    fn span_id_salting() {
        // The salt is per-process, so the first counter's emitted id is
        // overwhelmingly unlikely to be the bare `1`.
        assert_ne!(format_span_counter(1), format_span_id(1));
        assert_ne!(salt_span_id(1), salt_span_id(2));
        let mut ids = std::collections::HashSet::new();
        for counter in 1..=1000 {
            ids.insert(format_span_counter(counter).unwrap());
        }
        assert_eq!(ids.len(), 1000);
    }

    /// §4 — a Rust controller can emit the full record: a structured error and
    /// an `event_name`, both first-class in the shared schema.
    #[test]
    fn emits_full_record() {
        let threshold = Arc::new(ThresholdCache::new(severity::TRACE));
        let sink = Arc::new(CollectingSink::default());
        let log = Logger::new(threshold, sink.clone());

        log.log_with(
            severity::ERROR,
            "upstream failed",
            Map::new(),
            LogOptions {
                error: Some(ErrorValue {
                    error_type: "ERR_UPSTREAM".into(),
                    message: "502".into(),
                    ..ErrorValue::default()
                }),
                event_name: Some("http.upstream.failed".into()),
                ..LogOptions::default()
            },
        );

        let records = sink.0.lock().unwrap();
        assert_eq!(records[0].event_name.as_deref(), Some("http.upstream.failed"));
        assert_eq!(records[0].error.as_ref().unwrap().error_type, "ERR_UPSTREAM");
        assert!(records[0].timestamp > 0);
    }

    /// Vector 5 — threshold gating; a suppressed record never reaches the sink.
    #[test]
    fn threshold_gating() {
        let threshold = Arc::new(ThresholdCache::new(severity::INFO));
        let sink = Arc::new(CollectingSink::default());
        let log = Logger::new(Arc::clone(&threshold), sink.clone());

        assert!(!log.enabled(severity::DEBUG));
        log.debug("suppressed");
        assert_eq!(sink.0.lock().unwrap().len(), 0);

        log.info("emitted");
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }

    /// §12.4 — a pushed threshold takes effect without rebuilding the logger.
    #[test]
    fn threshold_is_pushed_not_polled() {
        let threshold = Arc::new(ThresholdCache::new(severity::INFO));
        let sink = Arc::new(CollectingSink::default());
        let log = Logger::new(Arc::clone(&threshold), sink.clone());

        assert!(!log.enabled(severity::DEBUG));
        threshold.set(severity::DEBUG);
        assert!(log.enabled(severity::DEBUG));

        log.debug("now visible");
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }

    /// §8.3 — record attributes win over bound attributes.
    #[test]
    fn child_logger_merge_order() {
        let threshold = Arc::new(ThresholdCache::new(severity::TRACE));
        let sink = Arc::new(CollectingSink::default());
        let log = Logger::new(threshold, sink.clone());

        let mut bound = Map::new();
        bound.insert("shared".into(), Value::String("bound".into()));
        bound.insert("component".into(), Value::String("db".into()));
        let child = log.with(bound);

        let mut record = Map::new();
        record.insert("shared".into(), Value::String("record".into()));
        child.log(severity::INFO, "query", record);

        let records = sink.0.lock().unwrap();
        assert_eq!(records[0].attributes["shared"], Value::String("record".into()));
        assert_eq!(records[0].attributes["component"], Value::String("db".into()));
    }
}
