import {
  createCancellationSource,
  RuntimeError,
  type CancellationSource,
  type InvokeOptions,
} from "@telorun/sdk";

/** Translate embedder `InvokeOptions` (external signal / absolute deadline)
 *  into a seeded cancellation source, or `undefined` when nothing was requested
 *  so the dispatch path stays on its allocation-free sentinel. The caller
 *  disposes the returned source once the invoke settles. */
export function seedInvokeSource(opts?: InvokeOptions): CancellationSource | undefined {
  if (!opts?.signal && opts?.deadlineAt === undefined) return undefined;
  const source = createCancellationSource();
  if (opts.deadlineAt !== undefined) source.cancelAt(opts.deadlineAt);
  const signal = opts.signal;
  if (signal && !signal.aborted) {
    const onAbort = () => source.cancel(String(signal.reason ?? "aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    // Detach from the (possibly long-lived) external signal on dispose so the
    // listener — which captures the source — doesn't pin it until the signal
    // eventually aborts (or forever if it never does).
    const baseDispose = source.dispose.bind(source);
    source.dispose = () => {
      signal.removeEventListener("abort", onAbort);
      baseDispose();
    };
  } else if (signal?.aborted) {
    source.cancel(String(signal.reason ?? "aborted"));
  }
  return source;
}

export function parseRef(ref: string): { kind: string; name: string } {
  const lastDot = ref.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === ref.length - 1) {
    throw new RuntimeError(
      "ERR_INVALID_VALUE",
      `Invalid resource reference '${ref}': expected '<Kind>.<Name>' (e.g. 'Http.Server.Main') or pass { kind, name } directly.`,
    );
  }
  return { kind: ref.slice(0, lastDot), name: ref.slice(lastDot + 1) };
}
