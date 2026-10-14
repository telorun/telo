import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import { ERR_INVOKE_CANCELLED, InvokeError, isCancellationError } from "@telorun/sdk";

/** Settle with `call`, or reject with `ERR_INVOKE_CANCELLED` the moment the agent turn
 *  behind `invokeCtx` is cancelled. An abandoned call that later fails for another
 *  reason is logged, since nothing is left waiting to receive it. */
export function untilTurnCancelled<T>(
  call: Promise<T>,
  invokeCtx: InvokeContext | undefined,
  abandoned: {
    /** What was cancelled, opening the error message. */
    subject: string;
    log: ResourceContext["log"];
    /** The record written when the abandoned call fails afterwards. */
    lateFailure: string;
    attributes: Record<string, string>;
  },
): Promise<T> {
  const token = invokeCtx?.cancellation;
  if (!token) return call;
  return new Promise<T>((resolve, reject) => {
    let cancelled = false;
    const unsubscribe = token.onCancelled((reason) => {
      cancelled = true;
      reject(
        new InvokeError(
          ERR_INVOKE_CANCELLED,
          `${abandoned.subject} was cancelled (${reason ?? "no reason given"}).`,
        ),
      );
    });
    call.then(
      (value) => {
        unsubscribe();
        resolve(value);
      },
      (err: unknown) => {
        unsubscribe();
        if (!cancelled) {
          reject(err);
        } else if (!isCancellationError(err)) {
          abandoned.log.warn(abandoned.lateFailure, abandoned.attributes, { error: err });
        }
      },
    );
  });
}
