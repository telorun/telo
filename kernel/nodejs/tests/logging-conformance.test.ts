import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  formatUnixNano,
  parseLevelName,
  pinoLevelForSeverity,
  severityForPinoLevel,
  severityFloor,
  severityText,
  SEVERITY,
  SLOG_OFFSET,
  type LogRecord,
} from "@telorun/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileRedactionPolicy,
  ConsoleSink,
  decideColor,
  DropRegistry,
  encodeJson,
  encodePretty,
  FileSink,
  formatSpanCounter,
  formatSpanId,
  LoggingPipeline,
  normalizeAttributes,
  redactAttributes,
  saltSpanId,
} from "../src/logging/index.js";

/**
 * The required test vectors of `kernel/specs/logging.md` §16.1. Numbering
 * follows the spec so a failure names the clause it violates.
 */

const FIXED_TIMESTAMP = 1_770_000_000_123_456_000n;

function collector() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { write: (chunk: string) => void chunks.push(chunk) } as unknown as NodeJS.WritableStream,
  };
}

function baseRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: FIXED_TIMESTAMP,
    severityNumber: SEVERITY.info,
    severityText: "INFO",
    message: "listening",
    ...overrides,
  };
}

describe("vector 1 — severity round-trip", () => {
  it("maps each named level to its number and back", () => {
    const expected: [string, number][] = [
      ["trace", 1],
      ["debug", 5],
      ["info", 9],
      ["warn", 13],
      ["error", 17],
      ["fatal", 21],
    ];
    for (const [name, number] of expected) {
      expect(parseLevelName(name)).toBe(number);
      expect(severityText(number)).toBe(name.toUpperCase());
    }
  });

  it("lands an unmappable source level on the range floor", () => {
    expect(parseLevelName("verbose")).toBeUndefined();
    // A source level of 7 is inside the DEBUG range (5–8).
    expect(severityFloor(7)).toBe(5);
    expect(severityText(7)).toBe("DEBUG");
  });

  it("does not resolve an Object.prototype member as a level", () => {
    // Regression: `in` matched inherited members, so parseLevelName("toString")
    // returned a Function and defeated the `?? fallback` at every call site.
    expect(parseLevelName("toString")).toBeUndefined();
    expect(parseLevelName("constructor")).toBeUndefined();
    expect(parseLevelName("hasOwnProperty")).toBeUndefined();
  });

  it("never yields severity 0, which §5.1 forbids emitting", () => {
    expect(severityFloor(0)).toBe(1);
    expect(severityFloor(-5)).toBe(1);
    expect(severityFloor(99)).toBe(21);
  });
});

describe("vector 2 — Go offset", () => {
  it("severity_number - 9 equals the slog level for all six", () => {
    const slog: Record<string, number> = { trace: -8, debug: -4, info: 0, warn: 4, error: 8, fatal: 12 };
    for (const [name, severity] of Object.entries(SEVERITY)) {
      expect(severity - SLOG_OFFSET).toBe(slog[name]);
    }
  });

  it("uses the pino table, which has no arithmetic relation", () => {
    expect(pinoLevelForSeverity(SEVERITY.info)).toBe(30);
    expect(severityForPinoLevel(50)).toBe(SEVERITY.error);
    expect(severityForPinoLevel(35)).toBeUndefined();
  });
});

describe("vector 3 — id formatting", () => {
  it("renders the u64 value 1 zero-padded, never as '1'", () => {
    expect(formatSpanId(1n)).toBe("0000000000000001");
  });

  it("omits an all-zero id rather than emitting it", () => {
    expect(formatSpanId(0n)).toBeUndefined();
  });

  it("always renders exactly 16 lowercase hex characters", () => {
    for (const value of [1n, 255n, 2n ** 63n, 2n ** 64n - 1n]) {
      const formatted = formatSpanId(value)!;
      expect(formatted).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("vector 4 — span id salting", () => {
  it("does not emit the bare counter", () => {
    // The salt is per-process and random, so the first span's id is
    // overwhelmingly unlikely to be the counter itself.
    expect(formatSpanCounter(1)).not.toBe("0000000000000001");
  });

  it("keeps ids unique within one runtime", () => {
    const ids = new Set<string>();
    for (let counter = 1; counter <= 1000; counter += 1) ids.add(formatSpanCounter(counter)!);
    expect(ids.size).toBe(1000);
  });

  it("salting is bijective, so distinct counters never collide", () => {
    expect(saltSpanId(1)).not.toBe(saltSpanId(2));
  });
});

describe("vector 5 — threshold gating", () => {
  function pipelineAt(level: number) {
    const fallback = collector();
    const pipeline = new LoggingPipeline({ fallbackStream: { write: fallback.stream.write } as never });
    const sink = collector();
    pipeline.attach(
      new ConsoleSink({
        sinkId: "console",
        level,
        env: {},
        stdout: sink.stream,
        stderr: sink.stream,
        encoding: "json",
      }),
    );
    return { pipeline, sink };
  }

  it("(a) a guarded call does not evaluate its arguments", () => {
    const { pipeline } = pipelineAt(SEVERITY.info);
    const log = pipeline.createLogger({ threshold: SEVERITY.info, redaction: compileRedactionPolicy({}) });
    const expensive = vi.fn(() => "rendered");

    if (log.enabled(SEVERITY.debug)) log.debug("msg", { value: expensive() });

    expect(expensive).not.toHaveBeenCalled();
  });

  it("(b) an unguarded suppressed call reaches no sink", () => {
    const { pipeline, sink } = pipelineAt(SEVERITY.info);
    const log = pipeline.createLogger({ threshold: SEVERITY.info, redaction: compileRedactionPolicy({}) });

    log.debug("suppressed", { value: 1 });
    expect(sink.chunks).toHaveLength(0);

    log.info("emitted", { value: 1 });
    expect(sink.chunks).toHaveLength(1);
  });

  it("(c) a deferred value on a suppressed call is never resolved", () => {
    const { pipeline } = pipelineAt(SEVERITY.info);
    const log = pipeline.createLogger({ threshold: SEVERITY.info, redaction: compileRedactionPolicy({}) });
    const toLogValue = vi.fn(() => "expensive");

    log.debug("suppressed", { deferred: { toLogValue } });

    expect(toLogValue).not.toHaveBeenCalled();
  });

  it("resolves a deferred value on the emit path", () => {
    const { pipeline, sink } = pipelineAt(SEVERITY.info);
    const log = pipeline.createLogger({ threshold: SEVERITY.info, redaction: compileRedactionPolicy({}) });

    log.info("emitted", { deferred: { toLogValue: () => "expensive" } });

    expect(sink.chunks[0]).toContain('"deferred":"expensive"');
  });
});

describe("vector 6 — redaction", () => {
  function redact(attributes: Record<string, unknown>, paths: string[]) {
    const normalized = normalizeAttributes(attributes as never).attributes;
    redactAttributes(normalized, compileRedactionPolicy({ paths }));
    return normalized;
  }

  it("redacts dot notation", () => {
    expect(redact({ a: { b: "secret" } }, ["a.b"])).toEqual({ a: { b: "[redacted]" } });
  });

  it("redacts bracket notation", () => {
    expect(redact({ a: { "b-c": "secret" } }, ['a["b-c"]'])).toEqual({ a: { "b-c": "[redacted]" } });
  });

  it("redacts a trailing wildcard", () => {
    expect(redact({ a: { x: "1", y: "2" } }, ["a.*"])).toEqual({
      a: { x: "[redacted]", y: "[redacted]" },
    });
  });

  it("redacts an array wildcard", () => {
    expect(redact({ items: [{ secret: "a" }, { secret: "b" }] }, ["items[*].secret"])).toEqual({
      items: [{ secret: "[redacted]" }, { secret: "[redacted]" }],
    });
  });

  it("supports more than one wildcard per path", () => {
    const result = redact(
      { items: [{ tokens: [{ value: "a" }, { value: "b" }] }] },
      ["items[*].tokens[*].value"],
    );
    expect(result).toEqual({ items: [{ tokens: [{ value: "[redacted]" }, { value: "[redacted]" }] }] });
  });

  it("preserves the key and replaces only the value", () => {
    const result = redact({ a: { b: "secret" } }, ["a.b"]) as { a: Record<string, unknown> };
    expect(Object.keys(result.a)).toEqual(["b"]);
  });

  it("redacts a manifest secret with no configuration at all", () => {
    const normalized = normalizeAttributes(
      { token: "s3cr3t", other: "fine" } as never,
      { secretValues: new Set(["s3cr3t"]) },
    ).attributes;
    expect(normalized).toEqual({ token: "[redacted]", other: "fine" });
  });

  it("rejects a path that would otherwise be compiled as source", () => {
    expect(() => compileRedactionPolicy({ paths: ["a[b-c]"] })).toThrow(/Invalid redaction path/);
  });

  it("remove: true over an array wildcard removes every element, not every other", () => {
    // Regression: splicing an array while iterating a precomputed index snapshot
    // left [a,b,c,d] as [b,d]. For the §14 security control that means a secret
    // in an array attribute is only partially removed.
    const normalized = normalizeAttributes({ items: ["a", "b", "c", "d"] } as never).attributes;
    redactAttributes(normalized, compileRedactionPolicy({ paths: ["items[*]"], remove: true }));
    expect(normalized).toEqual({ items: [] });
  });

  it("remove: true drops a matched object key without disturbing siblings", () => {
    const normalized = normalizeAttributes(
      { creds: { user: "u", pass: "p" } } as never,
    ).attributes;
    redactAttributes(normalized, compileRedactionPolicy({ paths: ["creds.pass"], remove: true }));
    expect(normalized).toEqual({ creds: { user: "u" } });
  });
});

describe("vector 7 — drop accounting", () => {
  afterEach(() => vi.useRealTimers());

  it("counts drops and emits exactly one warn on recovery", () => {
    vi.useFakeTimers();
    const reports: unknown[] = [];
    const drops = new DropRegistry((report) => reports.push(report));

    for (let i = 0; i < 5; i += 1) drops.record("audit", "buffer_full");
    expect(reports).toHaveLength(0);

    vi.advanceTimersByTime(1500);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ sinkId: "audit", cause: "buffer_full", count: 5, total: 5 });
  });

  it("keeps a monotonic lifetime total", () => {
    const drops = new DropRegistry(() => {});
    drops.record("audit", "sink_error", 3);
    drops.record("audit", "sink_error", 2);
    expect(drops.total("audit", "sink_error")).toBe(5);
    drops.dispose();
  });

  it("counts a drop caused by emitting the recovery warning itself", () => {
    vi.useFakeTimers();
    // Regression: the reporting guard used to early-return from record()
    // entirely, so a drop produced while the recovery warning was in flight was
    // never counted — the exact silent loss this class forbids.
    const drops: DropRegistry = new DropRegistry(() => {
      // The warning emission itself drops one more record.
      drops.record("audit", "sink_error");
    });
    drops.record("audit", "sink_error");
    vi.advanceTimersByTime(1500);
    // Original drop + the one from the recovery path.
    expect(drops.total("audit", "sink_error")).toBe(2);
    drops.dispose();
  });
});

describe("vector 8 — color precedence", () => {
  it("NO_COLOR='' does NOT disable color", () => {
    expect(decideColor({ setting: "auto", env: { NO_COLOR: "" }, isTTY: true })).toBe(true);
  });

  it("NO_COLOR=1 disables color", () => {
    expect(decideColor({ setting: "auto", env: { NO_COLOR: "1" }, isTTY: true })).toBe(false);
  });

  it("an explicit color: always overrides NO_COLOR", () => {
    expect(decideColor({ setting: "always", env: { NO_COLOR: "1" }, isTTY: false })).toBe(true);
  });

  it("FORCE_COLOR=0 disables, other non-empty values enable", () => {
    expect(decideColor({ setting: "auto", env: { FORCE_COLOR: "0" }, isTTY: true })).toBe(false);
    expect(decideColor({ setting: "auto", env: { FORCE_COLOR: "1" }, isTTY: false })).toBe(true);
  });

  it("falls through to the descriptor, never to a CI variable", () => {
    expect(decideColor({ setting: "auto", env: { CI: "true" }, isTTY: false })).toBe(false);
    expect(decideColor({ setting: "auto", env: {}, isTTY: true })).toBe(true);
  });

  it("TERM=dumb disables color", () => {
    expect(decideColor({ setting: "auto", env: { TERM: "dumb" }, isTTY: true })).toBe(false);
  });
});

describe("vector 15 — encoding auto resolves per sink destination", () => {
  it("resolves to pretty against a TTY and json against a pipe", () => {
    const tty = new PassThrough() as unknown as NodeJS.WritableStream & { isTTY?: boolean };
    tty.isTTY = true;
    const pipe = new PassThrough() as unknown as NodeJS.WritableStream;

    const ttyChunks: string[] = [];
    const pipeChunks: string[] = [];
    (tty as unknown as PassThrough).on("data", (c) => ttyChunks.push(String(c)));
    (pipe as unknown as PassThrough).on("data", (c) => pipeChunks.push(String(c)));

    const ttySink = new ConsoleSink({
      sinkId: "tty",
      level: SEVERITY.trace,
      env: { NO_COLOR: "1" },
      stdout: tty,
      stderr: tty,
    });
    const pipeSink = new ConsoleSink({
      sinkId: "pipe",
      level: SEVERITY.trace,
      env: {},
      stdout: pipe,
      stderr: pipe,
    });

    ttySink.write(baseRecord());
    pipeSink.write(baseRecord());

    expect(ttyChunks.join("")).toContain("INFO ");
    expect(ttyChunks.join("")).not.toContain('"msg"');
    expect(pipeChunks.join("")).toContain('"msg":"listening"');
  });
});

describe("vector 16 — per-sink level", () => {
  it("creates the record once and offers it to each sink's own level", () => {
    const consoleOut = collector();
    const pipeline = new LoggingPipeline({ fallbackStream: { write: () => {} } });
    const dir = mkdtempSync(join(tmpdir(), "telo-log-"));
    const file = join(dir, "audit.jsonl");

    pipeline.attach(
      new ConsoleSink({
        sinkId: "console",
        level: SEVERITY.warn,
        env: {},
        stdout: consoleOut.stream,
        stderr: consoleOut.stream,
        encoding: "json",
      }),
    );
    const fileSink = new FileSink({
      sinkId: "audit",
      level: SEVERITY.debug,
      destination: file,
      onDrop: () => {},
    });
    pipeline.attach(fileSink);

    const log = pipeline.createLogger({ threshold: SEVERITY.info, redaction: compileRedactionPolicy({}) });
    log.debug("debug-only");
    fileSink.flushSync();

    expect(consoleOut.chunks).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toContain('"msg":"debug-only"');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("vector 17 — fatal flush tiering", () => {
  it("is durable on a file sink by the time log() returns, and never exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "telo-log-"));
    const file = join(dir, "fatal.jsonl");
    const pipeline = new LoggingPipeline({ fallbackStream: { write: () => {} } });
    pipeline.attach(
      new FileSink({ sinkId: "audit", level: SEVERITY.trace, destination: file, onDrop: () => {} }),
    );

    const log = pipeline.createLogger({ threshold: SEVERITY.trace, redaction: compileRedactionPolicy({}) });
    log.fatal("going down");

    // Read immediately: no await, no scheduler turn. The process is still alive,
    // because severity never implies control flow (D5).
    expect(readFileSync(file, "utf8")).toContain('"msg":"going down"');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("vector 18 — encoding golden files", () => {
  const golden = baseRecord({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    resource: { kind: "Http.Server", name: "api", id: "Http.Server.api" },
    module: "http-server",
    scope: "Api",
    attributes: { "net.host.port": 8080 },
  });

  it("encodes byte-identically under json", () => {
    expect(encodeJson(golden)).toBe(
      '{"time":"2026-02-02T02:40:00.123456000Z","level":"INFO","severity":9,"msg":"listening",' +
        '"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7",' +
        '"resource":{"kind":"Http.Server","name":"api","id":"Http.Server.api"},' +
        '"module":"http-server","scope":"Api","attributes":{"net.host.port":8080}}',
    );
  });

  it("renders nanosecond precision with a Z suffix", () => {
    expect(formatUnixNano(FIXED_TIMESTAMP)).toBe("2026-02-02T02:40:00.123456000Z");
  });

  it("emits attribute keys in sorted order for cross-runtime byte-identity", () => {
    // §11.1: attribute keys are arbitrary and must be sorted so a Node runtime
    // (insertion order) and a Rust one (BTreeMap) produce the same bytes. Keys
    // are supplied out of order; the encoding must sort them, recursively.
    const line = encodeJson(
      baseRecord({ attributes: { zeta: 1, alpha: { yankee: 2, bravo: 3 } } }),
    );
    expect(line).toContain('"attributes":{"alpha":{"bravo":3,"yankee":2},"zeta":1}');
  });

  it("renders the pretty layout of §11.2", () => {
    const line = encodePretty(golden, { color: false });
    // The time field is local-timezone, so it is asserted by shape; everything
    // after it is fixed and asserted literally.
    const [time, ...rest] = line.split("  ");
    expect(time).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(rest.join("  ")).toBe("INFO   Http.Server.api  listening  net.host.port=8080");
  });

  it("pads the level to 5 characters and never colors the message", () => {
    const warn = encodePretty(baseRecord({ severityNumber: 13, severityText: "WARN" }), {
      color: true,
    });
    expect(warn).toContain("\u001b[33mWARN \u001b[0m");
    expect(warn).toContain("listening");
    expect(warn).not.toContain("\u001b[33mlistening");
  });
});

describe("§6.3 — limits are applied by bounded iteration", () => {
  it("drops attributes past the count limit and reports the count", () => {
    const attributes: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) attributes[`k${i}`] = i;
    const result = normalizeAttributes(attributes as never);
    expect(Object.keys(result.attributes!)).toHaveLength(128);
    expect(result.droppedCount).toBe(72);
  });

  it("replaces an over-deep subtree rather than recursing", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    const result = normalizeAttributes({ deep } as never);
    expect(JSON.stringify(result.attributes)).toContain("[depth exceeded]");
  });

  it("survives a cycle without diverging", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    const result = normalizeAttributes({ cyclic } as never);
    expect(JSON.stringify(result.attributes)).toContain("[circular]");
  });

  it("does not mislabel a value shared between siblings as circular", () => {
    const shared = { id: 1 };
    const result = normalizeAttributes({ a: shared, b: shared } as never);
    expect(result.attributes).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it("catches a throwing deferred value instead of propagating it", () => {
    const result = normalizeAttributes({
      bad: {
        toLogValue() {
          throw new Error("boom");
        },
      },
    } as never);
    expect(result.attributes!["bad"]).toContain("deferred value threw");
  });
});

describe("§8.3 — child loggers", () => {
  it("merges bound attributes with record attributes winning", () => {
    const sink = collector();
    const pipeline = new LoggingPipeline({ fallbackStream: { write: () => {} } });
    pipeline.attach(
      new ConsoleSink({
        sinkId: "console",
        level: SEVERITY.trace,
        env: {},
        stdout: sink.stream,
        stderr: sink.stream,
        encoding: "json",
      }),
    );

    const log = pipeline
      .createLogger({ threshold: SEVERITY.trace, redaction: compileRedactionPolicy({}) })
      .with({ component: "db", shared: "bound" });

    log.info("query", { shared: "record" });

    const parsed = JSON.parse(sink.chunks[0]!) as { attributes: Record<string, unknown> };
    expect(parsed.attributes).toEqual({ component: "db", shared: "record" });
  });
});

describe("§8.4 — logging never breaks the application", () => {
  it("does not throw when a sink throws, and reports out-of-band", () => {
    const fallback: string[] = [];
    const pipeline = new LoggingPipeline({
      fallbackStream: { write: (chunk: string) => void fallback.push(chunk) },
    });
    pipeline.attach({
      sinkId: "broken",
      level: SEVERITY.trace,
      syncFlushable: true,
      write() {
        throw new Error("disk on fire");
      },
      flush: async () => {},
      flushSync: () => {},
      close: async () => {},
    });

    const log = pipeline.createLogger({ threshold: SEVERITY.trace, redaction: compileRedactionPolicy({}) });

    expect(() => log.info("still fine")).not.toThrow();
    expect(fallback.join("")).toContain('sink "broken" failed');
  });
});
