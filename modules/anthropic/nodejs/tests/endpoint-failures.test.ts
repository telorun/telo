import { describe, expect, it, vi } from "vitest";
import { InvokeError, type InvokeContext } from "@telorun/sdk";

import * as response from "../src/messages-response.js";
import { ANSWER, outcome, over } from "./messages-stub.js";

// Everything the kind raises is one of the codes `Ai.Model` declares: a refused
// status, the vendor's own error wherever it is readable, a rejection of the
// injected request, and an answer that cannot be read.

const ASK = { messages: [{ role: "user", content: "hi" }] };

const vendor = (type?: string, message = "the vendor's words") => ({
  type: "error",
  error: { message, ...(type ? { type } : {}) },
});

const answers = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  over(async () => ({
    status,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

describe("a refused status", () => {
  it("reports a rate limit with the wait the endpoint asked for", async () => {
    const { model } = await answers(429, vendor("rate_limit_error", "slow down"), { "retry-after": "7" });
    const error = await outcome(model, ASK);
    expect(error).toMatchObject({ code: "ERR_MODEL_RATE_LIMITED" });
    expect(error.data).toEqual({ status: 429, retryAfterSeconds: 7 });
    expect(error.message).toContain("slow down");
  });

  it.each<[number, unknown, string]>([
    [401, vendor("authentication_error"), "ERR_MODEL_ACCESS_DENIED"],
    [403, vendor("permission_error"), "ERR_MODEL_ACCESS_DENIED"],
    [402, vendor("billing_error"), "ERR_MODEL_QUOTA_EXCEEDED"],
    // A type that names one failure wins over the status.
    [400, vendor("billing_error"), "ERR_MODEL_QUOTA_EXCEEDED"],
    [400, vendor("rate_limit_error"), "ERR_MODEL_RATE_LIMITED"],
    [413, vendor("request_too_large"), "ERR_MODEL_CONTEXT_TOO_LONG"],
    [
      400,
      vendor("invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum"),
      "ERR_MODEL_CONTEXT_TOO_LONG",
    ],
    [400, vendor("invalid_request_error"), "ERR_MODEL_REQUEST_REJECTED"],
    [404, vendor("not_found_error"), "ERR_MODEL_REQUEST_REJECTED"],
    [529, vendor("overloaded_error"), "ERR_MODEL_UNAVAILABLE"],
    [500, vendor("api_error"), "ERR_MODEL_UNAVAILABLE"],
    // A type that says only whose fault it is never overrides the status.
    [401, vendor("invalid_request_error"), "ERR_MODEL_ACCESS_DENIED"],
    [404, vendor("api_error"), "ERR_MODEL_REQUEST_REJECTED"],
    [504, vendor("timeout_error"), "ERR_MODEL_TIMEOUT"],
    [503, "upstream connect error", "ERR_MODEL_UNAVAILABLE"],
    [302, "", "ERR_MODEL_REQUEST_REJECTED"],
  ])("%i with %j is %s", async (status, body, code) => {
    const { model } = await answers(status, body);
    expect(await outcome(model, ASK)).toMatchObject({ code, data: { status } });
  });
});

describe("a refused response that is hard to judge", () => {
  it("classifies by status when the error's type is a member of every object", async () => {
    for (const type of ["constructor", "toString", "__proto__"]) {
      const { model } = await answers(429, vendor(type), { "retry-after": "7" });
      const raised = await outcome(model, ASK);
      expect(raised.code).toBe("ERR_MODEL_RATE_LIMITED");
      expect(raised.data).toEqual({ status: 429, retryAfterSeconds: 7 });
    }
  });

  it("raises one that cannot be read as a request not served", async () => {
    const broke = new Error("the body is gone");
    const { model } = await over(async () => ({
      status: 500,
      headers: {},
      get body(): unknown {
        throw broke;
      },
    }));
    expect(await outcome(model, ASK)).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", cause: broke });
  });
});

describe("a rejection of the injected request", () => {
  const network = (code: string) =>
    Object.assign(new Error("fetch failed"), { error: "NetworkError", code });
  const aborted = { cancellation: { signal: AbortSignal.abort() } } as unknown as InvokeContext;

  const rejects = async (err: unknown, ctx?: InvokeContext) => {
    const { model } = await over(async () => {
      throw err;
    });
    return outcome(model, ASK, ctx);
  };

  it("classifies each rejection, keeping the original as its cause", async () => {
    const classifier = new InvokeError("ERR_HTTP_CLASSIFIER_INVALID", "'success' must resolve");
    const unserved = await rejects(classifier);
    expect(unserved).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", data: {} });
    expect(unserved.cause).toBe(classifier);
    expect(unserved.message).toContain("[ERR_HTTP_CLASSIFIER_INVALID] 'success' must resolve");

    expect(await rejects(new Error("boom"))).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED" });
    expect(await rejects(new InvokeError("ERR_INVALID_CREDENTIAL", "empty key"))).toMatchObject({
      code: "ERR_MODEL_ACCESS_DENIED",
      data: {},
    });

    const timeout = network("TIMEOUT");
    expect(await rejects(timeout)).toMatchObject({ code: "ERR_MODEL_TIMEOUT", cause: timeout });
    for (const code of ["CONNECTION_REFUSED", "DNS_RESOLUTION_FAILED", "SSL_ERROR"]) {
      const unreachable = await rejects(network(code));
      expect(unreachable.code).toBe("ERR_MODEL_UNREACHABLE");
      expect(unreachable.data).toBeUndefined();
    }

    // The request's own `throwOnHttpError`: the same codes from its status and
    // body, without the wait a header would have named.
    const quota = await rejects(
      new InvokeError("ERR_HTTP_STATUS", "HTTP 400", {
        status: 400,
        body: JSON.stringify(vendor("billing_error")),
      }),
    );
    expect(quota).toMatchObject({ code: "ERR_MODEL_QUOTA_EXCEEDED", data: { status: 400 } });
    const limited = await rejects(new InvokeError("ERR_HTTP_STATUS", "HTTP 429", { status: 429 }));
    expect(limited.code).toBe("ERR_MODEL_RATE_LIMITED");
    expect(limited.data).toEqual({ status: 429 });
    expect(await rejects(new InvokeError("ERR_HTTP_STATUS", "HTTP ?", {}))).toMatchObject({
      code: "ERR_MODEL_REQUEST_REJECTED",
      data: {},
    });

    // What is not a model failure is never re-coded.
    for (const passes of [
      new InvokeError("ERR_INPUT_INVALID", "inputs"),
      new InvokeError("ERR_INVOKE_CANCELLED", "cancelled"),
      Object.assign(new Error("parked"), { code: "ERR_DURABLE_SUSPENDED" }),
      new InvokeError("ERR_MODEL_TIMEOUT", "already classified"),
    ]) {
      expect(await rejects(passes)).toBe(passes);
    }

    const abort = new Error("This operation was aborted");
    expect(await rejects(abort, aborted)).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: abort });
  });

  it("raises a request slot that is not live as an invalid reference", async () => {
    const { model } = await over(async () => ({}), { request: undefined });
    expect((await outcome(model, ASK)).code).toBe("ERR_INVALID_REFERENCE");
  });
});

describe("a success the endpoint did not make good on", () => {
  it("refuses a body that is not the answer", async () => {
    for (const body of ['{"content": [{"ty', "<html>bad gateway</html>", "[]", "", "{}", '{"content":[1]}']) {
      const { model } = await answers(200, body);
      const error = await outcome(model, ASK);
      expect(error.code, body).toBe("ERR_MODEL_RESPONSE_INVALID");
      expect(error.data).toBeUndefined();
    }
  });

  it.each([
    ["rate_limit_error", "ERR_MODEL_RATE_LIMITED"],
    ["authentication_error", "ERR_MODEL_ACCESS_DENIED"],
    ["invalid_request_error", "ERR_MODEL_REQUEST_REJECTED"],
    ["api_error", "ERR_MODEL_UNAVAILABLE"],
    ["never_heard_of_it", "ERR_MODEL_UNAVAILABLE"],
  ])("classifies the error %s in a success body as %s, over any answer beside it", async (type, code) => {
    const { model } = await answers(200, { ...ANSWER, ...vendor(type) });
    const error = await outcome(model, ASK);
    expect(error.code).toBe(code);
    expect(error.data).toEqual({});
  });
});

// Whatever else goes wrong in a call still leaves as a model failure: a request
// that could not be built before a success response is in hand, an answer that
// could not be read after. The original error is its cause.
describe("an error nothing else classifies", () => {
  it("raises a success body that cannot be read as an unreadable answer", async () => {
    const broke = new Error("the body is gone");
    const { model } = await over(async () => ({
      status: 200,
      headers: {},
      get body(): unknown {
        throw broke;
      },
    }));
    expect(await outcome(model, ASK)).toMatchObject({ code: "ERR_MODEL_RESPONSE_INVALID", cause: broke });
  });

  it("raises an error of its own reading of the answer as an unreadable answer", async () => {
    const fault = new Error("the reader broke");
    const reader = vi.spyOn(response, "readAnswer").mockImplementationOnce(() => {
      throw fault;
    });
    try {
      const { model } = await answers(200, ANSWER);
      expect(await outcome(model, ASK)).toMatchObject({ code: "ERR_MODEL_RESPONSE_INVALID", cause: fault });
    } finally {
      reader.mockRestore();
    }
  });

  it("raises messages that are not a list as a request that could not be built", async () => {
    const { model, invoke } = await over(async () => ({ status: 200, headers: {}, body: "{}" }));
    const error = await outcome(model, { messages: 5 });
    expect(error).toMatchObject({ code: "ERR_MODEL_REQUEST_REJECTED", data: {} });
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.message).toContain("could not be built");
    expect(invoke).not.toHaveBeenCalled();
  });
});
