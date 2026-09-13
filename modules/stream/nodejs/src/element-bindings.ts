/**
 * The per-element CEL bindings every stream stage exposes: the current `item`
 * and its zero-based `index`.
 *
 * The call's own inputs are deliberately not bound: a stage's only input is the
 * live stream it is draining, and an expression reading it would pull values
 * out from under the stage.
 *
 * `index` is an int64 (a BigInt) because every stage declares it
 * `type: integer` and a CEL integer is int64. A JS number reaches CEL as a
 * double, where `index % 2` has no overload — so it type-checked statically and
 * failed as the stream was drained. One source for the binding is what keeps
 * the stages from disagreeing about it again.
 */
export type ElementBindings = {
  readonly item: unknown;
  readonly index: bigint;
};

/**
 * Pairs each value of `input` with its bindings, lazily. Abandonment and a
 * failure in the stage's own body both reach this generator through
 * `for await`, which closes `input` in turn.
 */
export async function* elementBindings(
  input: AsyncIterable<unknown>,
): AsyncGenerator<ElementBindings> {
  let index = 0n;
  for await (const item of input) {
    yield { item, index };
    index++;
  }
}
