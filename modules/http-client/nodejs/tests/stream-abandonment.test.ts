import { PassThrough } from "stream";
import { describe, expect, it } from "vitest";
import { readBody } from "../src/http-request-controller.js";

/**
 * Abandonment: a consumer that stops draining a streamed response aborts the
 * request behind it.
 *
 * Here rather than in a manifest, because the assertion is about what the
 * TRANSPORT did and no manifest can observe that. The end-to-end test
 * (`tests/http-client-stream-abandonment.yaml`) documents its own limit: it
 * passes with the handler disabled, since a client that leaks a socket still
 * propagates the error and still serves the next call. This is the test that
 * actually fails when the abort is removed.
 */
function webStreamOf(chunks: Uint8Array[], onCancel: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // Deliberately never closes: a response still arriving is the only state
      // in which abandoning it means anything.
      if (i < chunks.length) controller.enqueue(chunks[i++]);
    },
    cancel() {
      onCancel();
    },
  });
}

function responseWith(body: ReadableStream<Uint8Array>): Response {
  return { body } as unknown as Response;
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("streamed response abandonment", () => {
  it("aborts the request and cancels the reader when the consumer stops draining", async () => {
    let cancelled = false;
    let aborted = false;
    const response = responseWith(
      webStreamOf([bytes("one"), bytes("two"), bytes("three")], () => {
        cancelled = true;
      }),
    );

    const out = (await readBody(response, "stream", {}, () => {
      aborted = true;
    })) as PassThrough;

    // Read once, then stop — `for await` calls `return()` on `break`, which
    // destroys the PassThrough. That close is the ONLY signal the transport
    // gets. What arrives in that first read is not the point: the pump is eager
    // and a PassThrough coalesces, so it may be one chunk or several.
    for await (const chunk of out) {
      expect(Buffer.from(chunk as Buffer).toString().length).toBeGreaterThan(0);
      break;
    }

    await new Promise((resolve) => setImmediate(resolve));

    expect(aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("does not abort a response the consumer drained to the end", async () => {
    let aborted = false;
    let i = 0;
    const chunks = [bytes("a"), bytes("b")];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
    });

    const out = (await readBody(responseWith(body), "stream", {}, () => {
      aborted = true;
    })) as PassThrough;

    const seen: string[] = [];
    for await (const chunk of out) seen.push(Buffer.from(chunk as Buffer).toString());

    await new Promise((resolve) => setImmediate(resolve));

    // The control that stops "abort always" from passing: a completed response
    // must not be reported as abandoned.
    expect(seen.join("")).toBe("ab");
    expect(aborted).toBe(false);
  });
});
