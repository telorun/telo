import type { Logger } from "@telorun/sdk";

/**
 * Releases a stream a kind was handed and never began to read. It runs while a
 * refusal is on its way out, or for a consumer that has already stopped, so a
 * release that fails is reported in the log rather than raised.
 */
export async function releaseUnread(input: unknown, who: string, log: Logger): Promise<void> {
  const open = (input as Partial<AsyncIterable<unknown>> | null | undefined)?.[Symbol.asyncIterator];
  if (typeof open !== "function") return;
  try {
    await open.call(input).return?.();
  } catch (err) {
    log.warn("Input not released", { resource: who }, { error: err });
  }
}
