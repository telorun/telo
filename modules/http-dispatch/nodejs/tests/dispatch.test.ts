import { describe, expect, it } from "vitest";
import { dispatchCatches, dispatchReturns } from "../src/dispatch.js";
import type { ModuleLikeContext, ValidateSchema } from "../src/dispatch.js";
import type { ResponseSink } from "../src/sink.js";
import type { CatchEntry, ReturnEntry } from "../src/schema.js";

/** Minimal `ModuleLikeContext` that evaluates CEL-like templates:
 *  - `$path.to.value` looks up the context (returns raw value)
 *  - `?path.to.value` looks up the context and coerces to a boolean (truthy)
 *  - nested objects/arrays are recursed
 *  Sufficient for dispatcher-shape tests — full CEL is exercised via
 *  http-server's YAML test suite. The dispatcher's `matchEntry` requires
 *  `when:` to evaluate to strict `=== true`, mirroring real CEL boolean
 *  predicates. */
function makeModuleContext(): ModuleLikeContext {
  const lookup = (path: string, ctx: Record<string, unknown>): unknown => {
    const parts = path.split(".");
    let cur: any = ctx;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  };
  const expand = (v: unknown, ctx: Record<string, unknown>): unknown => {
    if (typeof v === "string") {
      if (v.startsWith("$")) return lookup(v.slice(1), ctx);
      if (v.startsWith("?")) return !!lookup(v.slice(1), ctx);
    }
    if (Array.isArray(v)) return v.map((x) => expand(x, ctx));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = expand(val, ctx);
      return out;
    }
    return v;
  };
  return { expandWith: expand };
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  isStream: boolean;
}

interface SinkHandle {
  sink: ResponseSink;
  result: Promise<CapturedResponse>;
}

function makeInMemorySink(): SinkHandle {
  let status = 200;
  const headers: Record<string, string> = {};
  const chunks: Uint8Array[] = [];
  let sent = false;
  let isStream = false;
  let resolveResult!: (v: CapturedResponse) => void;
  const result = new Promise<CapturedResponse>((res) => (resolveResult = res));

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
      if (sent) throw new Error("setStatus after send");
      status = code;
    },
    setHeader(name, value) {
      if (sent) throw new Error("setHeader after send");
      headers[name.toLowerCase()] = value;
    },
    async send(body) {
      if (sent) throw new Error("double send");
      sent = true;
      if (body !== undefined) {
        chunks.push(new TextEncoder().encode(JSON.stringify(body)));
      }
      resolveResult({ status, headers, body: commit(), isStream });
    },
    async stream(iter, onError) {
      if (sent) throw new Error("stream after send");
      sent = true;
      isStream = true;
      try {
        for await (const chunk of iter) chunks.push(chunk);
      } catch (err) {
        if (onError) await onError(err);
      }
      resolveResult({ status, headers, body: commit(), isStream });
    },
  };

  return { sink, result };
}

const noopValidate: ValidateSchema = () => {};

describe("dispatchReturns", () => {
  it("renders a 204-style empty response when entry has no content", async () => {
    const returns: ReturnEntry[] = [{ status: 204 }];
    const { sink, result } = makeInMemorySink();
    await dispatchReturns(
      returns,
      undefined,
      {},
      undefined,
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(204);
    expect(captured.body.byteLength).toBe(0);
  });

  it("renders a buffered body and sets Content-Type from the matched mime", async () => {
    const returns: ReturnEntry[] = [
      {
        status: 200,
        content: { "application/json": { body: "$result" } },
      },
    ];
    const { sink, result } = makeInMemorySink();
    await dispatchReturns(
      returns,
      { ok: true },
      {},
      undefined,
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(200);
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(captured.body))).toEqual({ ok: true });
  });

  it("renders 406 when no content[mime] matches Accept", async () => {
    const returns: ReturnEntry[] = [
      { status: 200, content: { "text/html": { body: "<p>hi</p>" } } },
    ];
    const { sink, result } = makeInMemorySink();
    await dispatchReturns(
      returns,
      {},
      {},
      "application/json",
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(406);
    expect(captured.headers["content-type"]).toBe("application/json");
    const envelope = JSON.parse(new TextDecoder().decode(captured.body));
    expect(envelope.error.code).toBe("NOT_ACCEPTABLE");
  });

  it("picks the first entry whose `when:` evaluates truthy", async () => {
    const returns: ReturnEntry[] = [
      { status: 404, when: "?missing", content: { "application/json": { body: { route: "fallback" } } } },
      { status: 200, content: { "application/json": { body: "$result" } } },
    ];
    const { sink, result } = makeInMemorySink();
    await dispatchReturns(
      returns,
      { ok: true },
      {},
      undefined,
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(captured.body))).toEqual({ ok: true });
  });

  it("treats `when: false` as a non-matching predicate, not as the catch-all", async () => {
    // Regression: a truthiness check on `entry.when` would record this entry
    // as the fallback (because `!false` is true) and then return it when
    // nothing matched, even though its `when:` explicitly says "do not fire".
    // matchEntry must distinguish absence (`undefined`) from a literal false.
    const returns: ReturnEntry[] = [
      {
        status: 418,
        when: false as unknown as string,
        content: { "application/json": { body: { teapot: true } } },
      },
      { status: 200, content: { "application/json": { body: "$result" } } },
    ];
    const { sink, result } = makeInMemorySink();
    await dispatchReturns(
      returns,
      { ok: true },
      {},
      undefined,
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(captured.body))).toEqual({ ok: true });
  });

  it("honors q=0 on a more specific Accept media range over a wildcard match", async () => {
    // RFC 9110 §12.5.1: `application/json;q=0, */*;q=1` excludes
    // application/json — the exact-match q=0 outranks the wildcard q=1.
    // A naive "max q across matches" would still pick application/json
    // via the wildcard and serve a representation the client said it didn't
    // want.
    const returns: ReturnEntry[] = [
      {
        status: 200,
        content: {
          "application/json": { body: { kind: "json" } },
          "text/plain": { body: "plain" },
        },
      },
    ];
    const { sink, result } = makeInMemorySink();
    await dispatchReturns(
      returns,
      {},
      {},
      "application/json;q=0, */*;q=1",
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(200);
    expect(captured.headers["content-type"]).toBe("text/plain");
  });

  it("streams encoded bytes via sink.stream and calls the streamError hook on iterator failure", async () => {
    const failure = new Error("encoder pipeline burst");
    const encoder = {
      async invoke(_input: { input: AsyncIterable<unknown> }) {
        async function* gen(): AsyncIterable<Uint8Array> {
          yield new TextEncoder().encode("part-1\n");
          throw failure;
        }
        return { output: gen() };
      },
    };
    const returns: ReturnEntry[] = [
      {
        status: 200,
        mode: "stream",
        content: {
          "text/event-stream": { encoder: encoder as any },
        },
      },
    ];
    const observed: Array<{ err: unknown; ctx: { status: number; mime: string } }> = [];
    const { sink, result } = makeInMemorySink();
    async function* upstream(): AsyncIterable<string> {
      yield "row-1";
    }
    await dispatchReturns(
      returns,
      { output: upstream() },
      {},
      undefined,
      makeModuleContext(),
      noopValidate,
      sink,
      (err, ctx) => {
        observed.push({ err, ctx });
      },
    );
    const captured = await result;
    expect(captured.status).toBe(200);
    expect(captured.headers["content-type"]).toBe("text/event-stream");
    expect(captured.isStream).toBe(true);
    expect(new TextDecoder().decode(captured.body)).toBe("part-1\n");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.err).toBe(failure);
    expect(observed[0]!.ctx).toEqual({ status: 200, mime: "text/event-stream" });
  });
});

describe("dispatchCatches", () => {
  it("renders a default 500 envelope when no catches list matches", async () => {
    const { sink, result } = makeInMemorySink();
    await dispatchCatches(
      undefined,
      { code: "Internal", message: "boom" },
      {},
      undefined,
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(500);
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(captured.body))).toEqual({
      error: { code: "Internal", message: "boom" },
    });
  });

  it("renders a matched catch with its content body", async () => {
    const catches: CatchEntry[] = [
      {
        status: 400,
        when: "?error.code",
        content: { "application/json": { body: { code: "$error.code" } } },
      },
    ];
    const { sink, result } = makeInMemorySink();
    await dispatchCatches(
      catches,
      { code: "Validation", message: "bad input" },
      {},
      undefined,
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(captured.body))).toEqual({ code: "Validation" });
  });

  it("overrides Content-Type to application/json when no body: is provided", async () => {
    // Verifies the last-write-wins semantic on setHeader — the dispatcher
    // negotiates text/plain, then replaces it with application/json before
    // sending the default error envelope.
    const catches: CatchEntry[] = [
      {
        status: 500,
        content: { "text/plain": {} },
      },
    ];
    const { sink, result } = makeInMemorySink();
    await dispatchCatches(
      catches,
      { code: "Internal", message: "boom" },
      {},
      "text/plain",
      makeModuleContext(),
      noopValidate,
      sink,
    );
    const captured = await result;
    expect(captured.status).toBe(500);
    expect(captured.headers["content-type"]).toBe("application/json");
    const env = JSON.parse(new TextDecoder().decode(captured.body));
    expect(env.error.code).toBe("Internal");
  });
});
