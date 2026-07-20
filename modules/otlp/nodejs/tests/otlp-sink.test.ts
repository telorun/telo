import { NOOP_LOGGER, type LogRecord, type LoggingHost, type ResourceContext } from "@telorun/sdk";
import { describe, expect, it, vi } from "vitest";
import { create } from "../src/otlp-sink-controller.js";

function stubContext(): ResourceContext & { attached: unknown[] } {
  const attached: unknown[] = [];
  const logging: LoggingHost = {
    attach: (sink) => void attached.push(sink),
    detach: () => {},
    levelFor: () => 9,
    recordDrop: () => {},
  };
  return { logging, log: NOOP_LOGGER, attached } as unknown as ResourceContext & {
    attached: unknown[];
  };
}

/** A stub context whose `recordDrop` accumulates the reported count. */
function countingContext(): { ctx: ResourceContext; dropped(): number } {
  let dropped = 0;
  const logging: LoggingHost = {
    attach: () => {},
    detach: () => {},
    levelFor: () => 9,
    recordDrop: (_sinkId, _cause, count = 1) => {
      dropped += count;
    },
  };
  return {
    ctx: { logging, log: NOOP_LOGGER } as unknown as ResourceContext,
    dropped: () => dropped,
  };
}

describe("Otlp.Sink", () => {
  it("rejects on_full: block rather than silently degrading to dropping", async () => {
    // §10.3: `on_full` exists so an operator can state durability intent.
    // Substituting `drop_new` would hand back the opposite guarantee, discovered
    // from a gap in an audit trail rather than from an error.
    await expect(
      create(
        { endpoint: "https://collector.invalid/v1/logs", on_full: "block", metadata: { name: "audit" } },
        stubContext(),
      ),
    ).rejects.toThrow(/on_full: block is not supported/);
  });

  it("names the offending sink in the diagnostic", async () => {
    await expect(
      create(
        { endpoint: "https://collector.invalid/v1/logs", on_full: "block", metadata: { name: "audit" } },
        stubContext(),
      ),
    ).rejects.toThrow(/"audit"/);
  });

  it("attaches itself and declares that it cannot be synchronously flushed", async () => {
    const ctx = stubContext();
    const instance = (await create(
      { endpoint: "https://collector.invalid/v1/logs", metadata: { name: "shipped" } },
      ctx,
    )) as unknown as { sink: { syncFlushable: boolean; sinkId: string; flushSync(): void } };

    expect(ctx.attached).toHaveLength(1);
    // Delivery is a network round-trip; blocking a producer on it would be a
    // deadlock on an event loop, not durability (§10.5).
    expect(instance.sink.syncFlushable).toBe(false);
    expect(instance.sink.sinkId).toBe("shipped");
    expect(() => instance.sink.flushSync()).not.toThrow();
  });

  it("batches records and POSTs OTLP/JSON on flush", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const instance = (await create(
      { endpoint: "https://collector.invalid/v1/logs", metadata: { name: "shipped" } },
      stubContext(),
    )) as unknown as { sink: { write(r: LogRecord): void; flush(): Promise<void> } };

    instance.sink.write({
      timestamp: 1_770_000_000_123_456_000n,
      severityNumber: 9,
      severityText: "INFO",
      message: "listening",
    });
    await instance.sink.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[];
    };
    const record = body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    // §11.3: 64-bit fields are decimal strings, enums are integers.
    expect(record["timeUnixNano"]).toBe("1770000000123456000");
    expect(record["severityNumber"]).toBe(9);
    expect(record["body"]).toEqual({ stringValue: "listening" });

    vi.unstubAllGlobals();
  });

  it("counts the whole lost batch on export failure, not one per failure", async () => {
    // Regression: a failed export dropped `records.length` records but counted 1,
    // so a shutdown report understated losses by up to a full buffer.
    const fetchMock = vi.fn(async () => new Response(null, { status: 503, statusText: "Unavailable" }));
    vi.stubGlobal("fetch", fetchMock);
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    const { ctx, dropped } = countingContext();
    const instance = (await create(
      { endpoint: "https://collector.invalid/v1/logs", metadata: { name: "shipped" } },
      ctx,
    )) as unknown as { sink: { write(r: LogRecord): void; flush(): Promise<void> } };

    for (let i = 0; i < 7; i += 1) {
      instance.sink.write({
        timestamp: 1n,
        severityNumber: 9,
        severityText: "INFO",
        message: `r${i}`,
      });
    }
    await instance.sink.flush();

    expect(dropped()).toBe(7);
    // The reason is surfaced on the fallback stream, not swallowed.
    expect(stderrWrites.join("")).toMatch(/export to .* failed: HTTP 503/);

    stderrSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
