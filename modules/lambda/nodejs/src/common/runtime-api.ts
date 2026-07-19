/**
 * AWS Lambda Runtime API helpers used by Lambda.Function's custom-mode poll
 * loop. The Runtime API is a small HTTP protocol exposed on
 * `$AWS_LAMBDA_RUNTIME_API` inside the execution environment; the loop polls
 * `/runtime/invocation/next`, processes the event, and POSTs the result back
 * to `/runtime/invocation/{requestId}/{response,error}`.
 *
 * See https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html.
 *
 * These helpers are package-internal. Users never call them; they exist only so
 * the Function controller can run the poll loop in custom mode.
 */

import { fetchOrThrow } from "@telorun/sdk";


export interface RuntimeInvocation {
  event: unknown;
  context: LambdaContext;
  /** Lambda Runtime API request id; used to post the response back. */
  requestId: string;
  /** Function ARN owning this invocation; mirrors `context.invokedFunctionArn`. */
  invokedFunctionArn: string;
  deadlineMs: number;
}

export interface LambdaContext {
  awsRequestId: string;
  invokedFunctionArn: string;
  /** Epoch milliseconds when AWS will hard-timeout the invocation. */
  deadlineMs: number;
  identity?: unknown;
  clientContext?: unknown;
}

/** Polls the AWS Runtime API for the next invocation. Blocks until AWS hands
 *  one over; resolves to the parsed event + context. Accepts an optional
 *  `AbortSignal` so SIGTERM teardown can cancel the in-flight long-poll —
 *  without it, `teardown()` would race with AWS's shutdown window because the
 *  poll request has no timeout of its own. */
export async function pollNext(
  runtimeApi: string,
  signal?: AbortSignal,
): Promise<RuntimeInvocation> {
  const res = await fetchOrThrow(
    `http://${runtimeApi}/2018-06-01/runtime/invocation/next`,
    { signal },
    { operation: "Lambda Runtime API /next", setting: "AWS_LAMBDA_RUNTIME_API" },
  );
  if (!res.ok) {
    throw new Error(`Lambda Runtime API /next returned ${res.status}: ${await res.text()}`);
  }
  const requestId = res.headers.get("lambda-runtime-aws-request-id") ?? "";
  const invokedFunctionArn = res.headers.get("lambda-runtime-invoked-function-arn") ?? "";
  const deadlineMsHeader = res.headers.get("lambda-runtime-deadline-ms");
  const deadlineMs = deadlineMsHeader ? Number(deadlineMsHeader) : Number.MAX_SAFE_INTEGER;
  const clientContextHeader = res.headers.get("lambda-runtime-client-context");
  const identityHeader = res.headers.get("lambda-runtime-cognito-identity");
  const event = await res.json();

  const context: LambdaContext = {
    awsRequestId: requestId,
    invokedFunctionArn,
    deadlineMs,
    // Optional headers — fall back to undefined on malformed JSON rather than
    // crash the poll loop. The runtime exposes these for SDK callers that opt
    // in; basic dispatch never reads them.
    clientContext: safeParseJson(clientContextHeader),
    identity: safeParseJson(identityHeader),
  };

  return { event, context, requestId, invokedFunctionArn, deadlineMs };
}

function safeParseJson(s: string | null | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** POSTs a successful response back to AWS for the given invocation. */
export async function postResponse(
  runtimeApi: string,
  requestId: string,
  response: unknown,
): Promise<void> {
  const res = await fetchOrThrow(
    `http://${runtimeApi}/2018-06-01/runtime/invocation/${requestId}/response`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response ?? null),
    },
    { operation: "Lambda Runtime API /response", setting: "AWS_LAMBDA_RUNTIME_API" },
  );
  if (!res.ok) {
    throw new Error(
      `Lambda Runtime API /response returned ${res.status}: ${await res.text()}`,
    );
  }
}

/** POSTs an invocation error back to AWS. AWS will treat the invocation as
 *  failed and surface the error to the caller / event source. */
export async function postError(
  runtimeApi: string,
  requestId: string,
  err: unknown,
): Promise<void> {
  const errorPayload =
    err instanceof Error
      ? {
          errorType: err.name || "Error",
          errorMessage: err.message,
          stackTrace: (err.stack ?? "").split("\n"),
        }
      : { errorType: "Error", errorMessage: String(err), stackTrace: [] };

  await fetchOrThrow(
    `http://${runtimeApi}/2018-06-01/runtime/invocation/${requestId}/error`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "lambda-runtime-function-error-type": errorPayload.errorType,
      },
      body: JSON.stringify(errorPayload),
    },
    { operation: "Lambda Runtime API /invocation-error", setting: "AWS_LAMBDA_RUNTIME_API" },
  );
  // Errors posted during error reporting are unrecoverable — we already failed
  // the invocation. The Runtime API rules call for fall-through here so the
  // poll loop can pick up the next event rather than die on the meta-error.
}

/** POSTs an init error back to AWS. Called by the bootstrap when kernel.boot()
 *  itself fails — there is no requestId yet since no invocation has arrived. */
export async function postInitError(runtimeApi: string, err: unknown): Promise<void> {
  const errorPayload =
    err instanceof Error
      ? {
          errorType: err.name || "Error",
          errorMessage: err.message,
          stackTrace: (err.stack ?? "").split("\n"),
        }
      : { errorType: "Error", errorMessage: String(err), stackTrace: [] };

  await fetchOrThrow(
    `http://${runtimeApi}/2018-06-01/runtime/init/error`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "lambda-runtime-function-error-type": errorPayload.errorType,
      },
      body: JSON.stringify(errorPayload),
    },
    { operation: "Lambda Runtime API /init-error", setting: "AWS_LAMBDA_RUNTIME_API" },
  );
}
