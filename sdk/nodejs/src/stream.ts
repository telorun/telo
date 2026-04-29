/**
 * Stream — a thin wrapper around an `AsyncIterable` that gives stream-typed
 * values a stable, recognized constructor.
 *
 * Why this exists: cel-js's runtime type-checker rejects values whose
 * constructor isn't one of `Object/Map/Array/Set` or a registered object type.
 * AsyncGenerator instances (the native shape of `async function*` results) hit
 * that rejection because their `.constructor` is an `AsyncGeneratorFunction`
 * object — typeof `"object"`, not `"function"` — which `Environment.registerType`
 * refuses to accept. Wrapping an iterable in a `new Stream(...)` gives the
 * resulting value a real-class constructor that cel-js can register and
 * recognize, so `${{ steps.X.result.output }}` evaluations pass through cleanly.
 *
 * The companion analyzer registers `Stream` as a CEL object type with no
 * fields — terminal access (passing the value through) succeeds, member access
 * (`result.output.text`, `result.output[0]`) raises a CEL error at runtime,
 * mirroring the analyzer's static check on `x-telo-stream` properties.
 *
 * Producers that yield streams (encoder controllers, `Ai.TextStream`, file
 * read sources, etc.) construct `new Stream(asyncIterable)` for any value
 * exposed on a stream-typed property. Consumers iterate via `for await`.
 *
 * The class implements `AsyncIterable<T>`, so all standard JS iteration
 * patterns work without unwrapping. Internally it forwards `Symbol.asyncIterator`
 * to the underlying iterable.
 */
export class Stream<T = unknown> implements AsyncIterable<T> {
  constructor(private readonly source: AsyncIterable<T>) {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.source[Symbol.asyncIterator]();
  }
}
