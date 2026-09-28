import {
  DEFAULT_BUFFER_POLICY,
  parseDurationMs,
  RuntimeError,
  type SinkBufferPolicy,
} from "@telorun/sdk";

/**
 * What the log sink and the trace sink share: the buffering policy read off the
 * manifest, and one OTLP/JSON POST under a timeout.
 */

export interface OtlpExportConfig {
  endpoint: string;
  headers?: Record<string, string>;
  timeout?: string;
  resourceAttributes?: Record<string, unknown>;
  buffer?: number;
  on_full?: string;
  flush_interval?: string;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** The sink's buffering policy. `on_full: block` is refused rather than
 *  degraded: on a single-threaded event loop, blocking the producer stalls the
 *  writer that would drain the buffer. */
export function bufferPolicyOf(config: OtlpExportConfig, sinkId: string): SinkBufferPolicy {
  if (config.on_full === "block") {
    throw new RuntimeError(
      "ERR_LOG_SINK_ON_FULL_UNSUPPORTED",
      `Sink "${sinkId}": on_full: block is not supported by this runtime ` +
        `(single-threaded event loop — blocking the producer would stall the writer). ` +
        `Use \`drop_new\` or \`drop_old\`, or move this sink to a worker thread.`,
    );
  }
  return {
    buffer: config.buffer ?? DEFAULT_BUFFER_POLICY.buffer,
    onFull: (config.on_full ?? DEFAULT_BUFFER_POLICY.onFull) as SinkBufferPolicy["onFull"],
    flushIntervalMs: config.flush_interval
      ? parseDurationMs(config.flush_interval, DEFAULT_BUFFER_POLICY.flushIntervalMs)
      : DEFAULT_BUFFER_POLICY.flushIntervalMs,
  };
}

/** POST one OTLP/JSON body. Resolves to why the export failed, or `undefined`
 *  when the collector accepted it — the caller decides what a failure costs. */
export async function postOtlp(
  endpoint: string,
  headers: Record<string, string>,
  timeoutMs: number,
  payload: unknown,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`;
  } catch (err) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    clearTimeout(timer);
  }
}
