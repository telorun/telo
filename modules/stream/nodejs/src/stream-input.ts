import { InvokeError } from "@telorun/sdk";

/**
 * The `input` slot, checked once for every transform.
 *
 * A live value is exempt from contract validation by design — the exemption
 * exists precisely to forbid iterating a stream to inspect it — so the kind's
 * declared `Telo.Stream` says nothing at dispatch about what actually arrived.
 * This is the only place that can tell an author they wired a list, or a
 * `null` from a step that returned nothing, into a stage that pulls.
 */
export function requireStream(
  input: unknown,
  kind: string,
  name: string,
): AsyncIterable<unknown> {
  if (
    !input ||
    typeof (input as Record<symbol, unknown>)[Symbol.asyncIterator] !== "function"
  ) {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `${kind} "${name}": 'input' must be an AsyncIterable.`,
    );
  }
  return input as AsyncIterable<unknown>;
}
