import { InvokeError, isCancellationError, isInvokeError } from "@telorun/sdk";

export const ERR_API_KEY_STORE_UNAVAILABLE = "ERR_API_KEY_STORE_UNAVAILABLE";
/** Terminal: a store answered with something its interface rules out. */
export const ERR_API_KEY_STORE_INCONSISTENT = "ERR_API_KEY_STORE_INCONSISTENT";

function isCodedRuntimeError(err: unknown): boolean {
  return (
    err instanceof Error && err.name === "RuntimeError" && typeof (err as { code?: unknown }).code === "string"
  );
}

/** Runs one store call. A cancellation and any error that already carries a
 *  Telo code pass through; any other failure is the storage's own, raised as
 *  `ERR_API_KEY_STORE_UNAVAILABLE` with the failure as its cause. */
export async function callStore<T>(describe: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isCancellationError(err) || isInvokeError(err) || isCodedRuntimeError(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new InvokeError(
      ERR_API_KEY_STORE_UNAVAILABLE,
      `${describe}: the key store failed — ${reason}`,
      undefined,
      { cause: err },
    );
  }
}

export function storeInconsistent(describe: string, what: string): InvokeError {
  return new InvokeError(
    ERR_API_KEY_STORE_INCONSISTENT,
    `${describe}: the key store answered ${what}, which its interface rules out; re-issuing the call cannot help.`,
  );
}
