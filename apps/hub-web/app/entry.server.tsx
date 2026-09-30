import { PassThrough } from "node:stream";

import { createReadableStreamFromReadable } from "@react-router/node";
import { renderToPipeableStream } from "react-dom/server";
import {
  type EntryContext,
  type HandleErrorFunction,
  isRouteErrorResponse,
  ServerRouter,
} from "react-router";

/** Re-exported so `server.mjs` reads the validated settings (the port) from the
 *  server build it already imports. */
export { settings } from "@/settings.server";

/** Every request renders to completion before the first byte, crawler or not:
 *  the status and headers are then final, and there is nothing deferred to
 *  stream. */
export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  return new Promise<Response>((resolve, reject) => {
    let status = responseStatusCode;
    // Held until the shell is known to have rendered: a shell error rejects,
    // and `handleError` logs it then.
    const renderErrors: unknown[] = [];
    const { pipe } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        onAllReady() {
          for (const error of renderErrors) console.error(error);
          const body = new PassThrough();
          responseHeaders.set("Content-Type", "text/html; charset=utf-8");
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers: responseHeaders,
              status,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          status = 500;
          renderErrors.push(error);
        },
      },
    );
  });
}

/** Deliberate statuses (a 404, the hub's 503) are not errors here — the loader
 *  that threw one has already logged what it needs to. Everything else is 5xx
 *  detail, and it is logged here and never sent. */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted || isRouteErrorResponse(error)) return;
  console.error(error);
};
