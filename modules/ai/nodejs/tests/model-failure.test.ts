import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import {
  AMBIENT_CONTRACT_ERROR_CODES,
  InvokeError,
  type InvokeContext,
} from "@telorun/sdk";
import {
  MODEL_FAILURE_CODES,
  modelAccessDenied,
  modelContentUnsupported,
  modelFailureFromError,
  modelFailureFromStatus,
  modelInvalidReference,
  modelRateLimited,
  modelResponseInvalid,
  modelToolArgumentsInvalid,
  modelUnreachable,
  retryAfterSeconds,
} from "../src/model-failure.js";

// The failures a model may raise are declared twice in the manifest — on
// `Ai.Model` and on `Ai.ModelStream` — and once here, as what a provider builds
// them with. This holds the three to one list, then pins what every provider
// shares: the HTTP status rows, `Retry-After`, and the boundary that decides
// which errors leave a model kind as they are.

const abstracts = parseAllDocuments(
  readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"),
  { logLevel: "silent" },
)
  .map((doc) => doc.toJS())
  .filter((doc) => doc?.kind === "Telo.Abstract");

const declaredCodes = (name: string): string[] =>
  Object.keys(abstracts.find((doc) => doc.metadata.name === name).throws.codes);

describe("the failure list", () => {
  it("is the same on Ai.Model, on Ai.ModelStream and in the exported codes", () => {
    expect(declaredCodes("Model")).toEqual([...MODEL_FAILURE_CODES]);
    expect(declaredCodes("ModelStream")).toEqual([...MODEL_FAILURE_CODES]);
    const byName = (name: string) => abstracts.find((doc) => doc.metadata.name === name).throws;
    expect(byName("ModelStream")).toEqual(byName("Model"));
  });

  it("builds each failure with only the data its code declares", () => {
    const cause = new Error("original");
    expect(modelAccessDenied("m")).toMatchObject({ code: "ERR_MODEL_ACCESS_DENIED", data: {} });
    expect(modelRateLimited("m", { status: 429, retryAfterSeconds: 3 }, { cause })).toMatchObject({
      code: "ERR_MODEL_RATE_LIMITED",
      data: { status: 429, retryAfterSeconds: 3 },
      cause,
    });
    expect(modelRateLimited("m", { status: 429, retryAfterSeconds: undefined }).data).toEqual({
      status: 429,
    });
    expect(
      modelContentUnsupported("m", { partType: "audio", scheme: undefined, mediaType: "audio/wav" })
        .data,
    ).toEqual({ partType: "audio", mediaType: "audio/wav" });
    expect(modelToolArgumentsInvalid("m", { tool: "lookup" }).data).toEqual({ tool: "lookup" });
    for (const failure of [modelUnreachable("m"), modelResponseInvalid("m"), modelInvalidReference("m")]) {
      expect(failure.data).toBeUndefined();
    }
    expect(modelInvalidReference("m").code).toBe("ERR_INVALID_REFERENCE");
  });
});

describe("the failure an HTTP status names", () => {
  it.each([
    [401, "ERR_MODEL_ACCESS_DENIED"],
    [403, "ERR_MODEL_ACCESS_DENIED"],
    [402, "ERR_MODEL_QUOTA_EXCEEDED"],
    [429, "ERR_MODEL_RATE_LIMITED"],
    [408, "ERR_MODEL_TIMEOUT"],
    [504, "ERR_MODEL_TIMEOUT"],
    [413, "ERR_MODEL_CONTEXT_TOO_LONG"],
    [400, "ERR_MODEL_REQUEST_REJECTED"],
    [404, "ERR_MODEL_REQUEST_REJECTED"],
    [422, "ERR_MODEL_REQUEST_REJECTED"],
    [500, "ERR_MODEL_UNAVAILABLE"],
    [503, "ERR_MODEL_UNAVAILABLE"],
    [529, "ERR_MODEL_UNAVAILABLE"],
    // Neither a success the caller accepted nor an error class: not served.
    [204, "ERR_MODEL_REQUEST_REJECTED"],
    [302, "ERR_MODEL_REQUEST_REJECTED"],
    [101, "ERR_MODEL_REQUEST_REJECTED"],
  ])("%i is %s, carrying the status", (status, code) => {
    const failure = modelFailureFromStatus(status, "m");
    expect(failure.code).toBe(code);
    expect(failure.data).toEqual({ status });
  });

  it("reads a status in either integer representation, and carries none it cannot read", () => {
    expect(modelFailureFromStatus(429n, "m").data).toEqual({ status: 429 });
    for (const status of [undefined, 0, 700, 429.5, "429", null]) {
      const failure = modelFailureFromStatus(status, "m");
      expect(failure.code).toBe("ERR_MODEL_REQUEST_REJECTED");
      expect(failure.data).toEqual({});
    }
  });

  it("carries the wait only on a rate limit and an unavailable endpoint", () => {
    const cause = new Error("original");
    expect(modelFailureFromStatus(429, "m", { retryAfter: "7", cause })).toMatchObject({
      data: { status: 429, retryAfterSeconds: 7 },
      cause,
    });
    expect(modelFailureFromStatus(503, "m", { retryAfter: "7" }).data).toEqual({
      status: 503,
      retryAfterSeconds: 7,
    });
    expect(modelFailureFromStatus(401, "m", { retryAfter: "7" }).data).toEqual({ status: 401 });
    expect(modelFailureFromStatus(429, "m", { retryAfter: "soon" }).data).toEqual({ status: 429 });
  });
});

describe("Retry-After", () => {
  it("reads delta-seconds rounded up, and an HTTP date as seconds from now", () => {
    expect(retryAfterSeconds("0")).toBe(0);
    expect(retryAfterSeconds(" 30 ")).toBe(30);
    expect(retryAfterSeconds("1.2")).toBe(2);
    const inTen = new Date(Date.now() + 9_500).toUTCString();
    expect(retryAfterSeconds(inTen)).toBeGreaterThanOrEqual(8);
    expect(retryAfterSeconds(inTen)).toBeLessThanOrEqual(10);
  });

  it.each([undefined, null, "", "  ", "soon", "-5", "Infinity", "NaN", "1e3", new Date(0).toUTCString()])(
    "is absent for %j",
    (text) => {
      expect(retryAfterSeconds(text)).toBeUndefined();
    },
  );
});

describe("the boundary an error leaves a model kind through", () => {
  const aborted = { cancellation: { signal: AbortSignal.abort() } } as unknown as InvokeContext;
  const live = {
    cancellation: { signal: new AbortController().signal },
  } as unknown as InvokeContext;
  const never = () => {
    throw new Error("otherwise must not be called");
  };

  it("keeps a cancelled invocation a cancellation, over an error that is already a model failure", () => {
    const classified = modelRateLimited("slow down");
    const raised = modelFailureFromError(classified, aborted, never);
    expect(raised).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: classified });
  });

  it("raises a raw abort as a cancellation carrying it", () => {
    const abort = new Error("This operation was aborted");
    const raised = modelFailureFromError(abort, aborted, never);
    expect(raised).toBeInstanceOf(InvokeError);
    expect(raised).toMatchObject({ code: "ERR_INVOKE_CANCELLED", cause: abort });
  });

  it.each([
    "ERR_INVOKE_CANCELLED",
    "ERR_DURABLE_SUSPENDED",
    ...AMBIENT_CONTRACT_ERROR_CODES,
    ...MODEL_FAILURE_CODES,
  ])("returns %s as the same object, asking nothing", (code) => {
    const err = Object.assign(new Error("as raised"), { code });
    for (const ctx of [undefined, live, code === "ERR_INVOKE_CANCELLED" ? aborted : live]) {
      expect(modelFailureFromError(err, ctx, never)).toBe(err);
    }
  });

  it.each([new Error("boom"), new InvokeError("ERR_HTTP_STATUS", "HTTP 500"), "a string", undefined])(
    "returns what the provider says %j is, asked once",
    (err) => {
      const asked: unknown[] = [];
      const answer = modelResponseInvalid("unreadable", { cause: err });
      const raised = modelFailureFromError(err, live, (given) => {
        asked.push(given);
        return answer;
      });
      expect(raised).toBe(answer);
      expect(asked).toEqual([err]);
    },
  );
});
