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
 * Singleton across sdk copies: cel-js identifies registered types by
 * constructor identity (`v.constructor === RegisteredCtor`). The kernel and
 * any npm-loaded controller can — and routinely do — resolve `@telorun/sdk`
 * to different installs (workspace vs `.telo/npm/<hash>/...`), so two `Stream`
 * classes with the same shape but different identity would silently break
 * stream-typed CEL evaluations with "Unsupported type: Stream". The first
 * `@telorun/sdk` copy to load registers its `Stream` class on `globalThis`
 * under a stable `Symbol.for("@telorun/sdk:Stream")` key; later copies discard
 * their local declaration at export time and re-export the registered one.
 * Every Stream value in the process shares one constructor regardless of
 * install topology — no build artifact or `file:` symlink required.
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

// Type binding: `Stream<T>` as written by consumers (`let s: Stream<number>`)
// resolves to this interface. The class below also conforms to it.
interface Stream<T = unknown> extends AsyncIterable<T> {}

// Value binding (private): the class declaration that supplies the runtime
// implementation. Written as a named class expression so `.name === "Stream"`
// — debuggers, stack traces, and `Object.prototype.toString` all see "Stream",
// not the const name. The inner `Stream` identifier is only visible inside
// the class body (for self-reference); it does not shadow the outer interface.
const LocalStream = class Stream<T = unknown> implements AsyncIterable<T> {
  // ECMAScript private field rather than TS `private readonly` — the latter
  // shows up in the inferred type signature, which TS then refuses to export
  // through an anonymous class expression (TS4094).
  #source: AsyncIterable<T>;

  constructor(source: AsyncIterable<T>) {
    this.#source = source;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.#source[Symbol.asyncIterator]();
  }
};

const STREAM_KEY = Symbol.for("@telorun/sdk:Stream");
const globalSlot = globalThis as Record<symbol, unknown>;
if (!(STREAM_KEY in globalSlot)) globalSlot[STREAM_KEY] = LocalStream;

// The exported value: whichever Stream class won the globalThis race (first
// sdk copy to import this module). Later copies discard their `LocalStream`
// at export time and route through the winner — keeping constructor identity
// stable across the kernel/controller realm boundary.
const Stream: typeof LocalStream = globalSlot[STREAM_KEY] as typeof LocalStream;

// `export { Stream }` re-exports the value binding (the const above) and the
// type binding (the interface above) under the same name — TypeScript treats
// value/type as separate namespaces, so a consumer's `import { Stream }`
// receives both `new Stream(...)` and `Stream<T>`.
export { Stream };
