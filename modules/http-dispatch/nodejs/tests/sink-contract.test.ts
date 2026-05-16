import { runSinkContract, type SinkHandle } from "../src/test-utils/sink-contract.js";
import type { ResponseSink } from "../src/sink.js";

/** A simple in-memory `ResponseSink` for testing the dispatcher and as a
 *  reference implementation that runs the shared contract harness. */
function makeInMemorySink(): SinkHandle {
  let status = 200;
  const headers: Record<string, string> = {};
  const chunks: Uint8Array[] = [];
  let sent = false;
  let isStream = false;
  let resolveResult!: (v: {
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
    isStream: boolean;
  }) => void;
  const result = new Promise<{
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
    isStream: boolean;
  }>((res) => (resolveResult = res));

  function commit(): Uint8Array {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  const sink: ResponseSink = {
    setStatus(code) {
      if (sent) throw new Error("setStatus called after send()");
      status = code;
    },
    setHeader(name, value) {
      if (sent) throw new Error("setHeader called after send()");
      headers[name.toLowerCase()] = value;
    },
    async send(body) {
      if (sent) throw new Error("send() called twice on the same sink");
      sent = true;
      if (body !== undefined) {
        const contentType = (headers["content-type"] ?? "").toLowerCase();
        let bytes: Uint8Array;
        if (body instanceof Uint8Array) {
          bytes = body;
        } else if (typeof body === "string") {
          bytes = new TextEncoder().encode(body);
        } else if (contentType.startsWith("application/json") || contentType === "") {
          bytes = new TextEncoder().encode(JSON.stringify(body));
        } else {
          bytes = new TextEncoder().encode(String(body));
        }
        chunks.push(bytes);
      }
      resolveResult({ status, headers, body: commit(), isStream });
    },
    async stream(iter, onError) {
      if (sent) throw new Error("stream() called after send()");
      sent = true;
      isStream = true;
      try {
        for await (const chunk of iter) {
          chunks.push(chunk);
        }
      } catch (err) {
        if (onError) await onError(err);
      }
      resolveResult({ status, headers, body: commit(), isStream });
    },
  };

  return { sink, result };
}

runSinkContract("in-memory sink", makeInMemorySink);
