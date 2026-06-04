# Binary streaming prerequisites (registry tar.gz)

Generic stdlib primitives that let binary streams flow from an HTTP upload,
through de/compression and archive extraction, into object storage. Required by
the tar.gz-accepting registry (see
[kernel/nodejs/plans/bundle-controllers.md](../../../kernel/nodejs/plans/bundle-controllers.md)),
but transport-neutral and independently useful.

**These modules must be released and published to the registry _before_ the
registry app's manifest is adjusted to use them** — the registry imports them
like any other dependency. Land and publish this plan first; the registry
handler rewrite (in the bundle-controllers plan) depends on it.

The codec abstraction already exists
([modules/codec](../../codec/telo.yaml): `Codec.Encoder` / `Codec.Decoder`,
`Stream<Uint8Array>` flowing through `octet-codec`/`ndjson-codec`, `S3.Get`
already returning a byte stream). `Gzip.Decoder` extends `Codec.Decoder`;
`Tar.Extract` is a plain Invocable that consumes a byte stream and emits one.

## 1. Binary HTTP request body (modules/http-server, modules/http-dispatch)

Today every body is `parseAs: "string"`
([http-server-controller.ts:111-130](../nodejs/src/http-server-controller.ts#L111-L130)) —
every content-type parser materializes the body as a UTF-8 string, so binary
cannot enter the system over HTTP. Two coupled changes are needed.

### A raw-stream parser, not a buffer

The body must arrive as `Stream<Uint8Array>`, never buffered. Fastify produces
this only when the content-type parser **omits `parseAs`** and hands back the
raw request stream (`addContentTypeParser(mime, (req, payload, done) =>
done(null, payload))`, `payload` being the Node request stream). The controller
wraps that stream in `new Stream(...)` and exposes it as `request.body`.
`parseAs: "buffer"` is explicitly **not** the path — it materializes the whole
upload in memory and yields a `Buffer`, not a stream, defeating the premise for
large artifacts.

### Route intent → server-global parser (the real wiring)

Content-type parsers are registered on the **Http.Server** resource
(`contentTypeParsers`), decoupled from the `Http.Api` routes mounted onto it.
So a per-route `x-telo-stream` body cannot, by itself, change how the server
parses — that wiring is the actual work:

- The Http.Server controller, when mounting routes, **collects the set of MIMEs
  whose route declares an `x-telo-stream: true` `request.schema.body`** and
  registers a raw passthrough-stream parser for each at the server level. This
  keeps the single source of truth on the route (topology-driven) while
  respecting where parsers physically live.
- **Documented constraint:** a given MIME on one Http.Server is *either*
  stream-passthrough *or* string/JSON-parsed — two routes on the same server
  cannot split one MIME into a binary and a string variant. Surface this as a
  load-time diagnostic if a server has both for the same MIME.
- For stream-bodied routes, **skip AJV** on the body (a stream is opaque to
  schema validation); non-marked routes keep current string/JSON behaviour
  unchanged.
- `http-dispatch` request schema
  ([modules/http-dispatch/telo.yaml:43-46](../../http-dispatch/telo.yaml#L43-L46))
  documents the stream-body option. No content-type is hardcoded in the
  transport.

### Analyzer

A stream-marked `request.body` types as `Stream<Uint8Array>` in handler CEL;
member access past the stream boundary is rejected (same as other
`x-telo-stream` props). The handler may only pipe `request.body` whole into a
stream-consuming invocable (e.g. `Octet.Decoder`), never dereference it.

This is the keystone — without it the gzip/tar kinds have no binary source over
HTTP. Build it first.

## 2. `std/gzip` (new module)

- `Gzip.Decoder` — capability `Telo.Invocable`, `extends Codec.Decoder`. Input
  `{ input }` (the inherited `x-telo-stream` byte stream), `outputType
  { output }` with `x-telo-stream: true` — a byte stream, **not** collected, so
  it pipes straight into `Tar.Extract` (§3). Controller wraps Node
  `zlib.createGunzip()`; output wrapped in `new Stream(...)` so the SDK's
  stream-identity check passes.
- `Gzip.Encoder` deferred (publish-side gzips in the CLI directly; add later for
  symmetry alongside future brotli/zstd siblings).
- Docs in `modules/gzip/docs/`, wired into `pages/docusaurus.config.ts` +
  `pages/sidebars.ts`, `sidebar_label` frontmatter on the markdown.
- Changie fragment (`Added`). Controller npm package + changeset.

## 3. `std/tar` (new module)

A whole-archive `Tar.Decoder` that emits `Stream<{ path, contents:
Stream<… > }>` is **not consumable in a manifest**: the stream-boundary rule
forbids reaching `entry.path` / `entry.contents`, and `x-telo-stream` has no
element typing yet (boolean today; `{ items: … }` is future per CLAUDE.md). The
keystone consumer only needs *one named file* (`telo.yaml`) out of the archive,
so the kind is shaped around that:

- `Tar.Extract` — capability `Telo.Invocable` (a plain Invocable, not a
  `Codec.Decoder` — it takes a selector arg, not just a stream). `inputType`:
  `{ input }` (`x-telo-stream` byte stream) + `path: string` (the entry to
  pull). `outputType`: `{ output }` with `x-telo-stream: true` — the named
  entry's byte stream, which pipes whole into `PlainText.Decoder` →
  `Yaml.Parse`. No member access past a stream is ever required.
- `throws ERR_NOT_FOUND` when `path` is absent from the archive.
- Controller uses the `tar-stream` npm package; finds the matching entry, wraps
  its byte stream in `new Stream(...)`, and drains/skips the rest.
- **Deferred:** a record-stream `Tar.Decoder` (enumerate all entries) waits on
  `x-telo-stream: { items }` element typing. The only current need for full
  enumeration — extracting the published tarball into the consumer's
  `.telo/manifests` cache — is done in Node (CLI/kernel), not via a kind.
- Docs + Docusaurus wiring + changie fragment (`Added`). Controller npm package
  + changeset.

## 4. `S3` module — binary `Put`, new `Delete` (modules/s3)

The module today exports `Bucket` / `List` / `Put` / `Get`
([modules/s3/telo.yaml](../../s3/telo.yaml)). Two changes:

**`S3.Put` binary.** Widen `inputs.body` from `{ type: string }` to a
**buffered binary** value — `oneOf: [{ type: string }, { type: object }]`,
where `type: object` is the `Uint8Array` representation `Octet.Decoder` already
produces (`bytes: { type: object }`, [octet-codec/telo.yaml](../../octet-codec/telo.yaml)).
This is the type-safe, **non-breaking** (additive `Added`, existing string
callers still valid) widening — and deliberately **not** `x-telo-stream`:

- A live `Stream` can't be stored *and* extracted from one upload, so the
  registry buffers once via `Octet.Decoder` (`request.body` → `bytes:
  Uint8Array`) and uses **store-then-read-back through `S3.Get`** (already a
  byte stream) as the tee. So `S3.Put` is handed a buffered `Uint8Array`, never
  a stream — no streaming-put kind, no `x-telo-stream` body (which couldn't
  coexist with the string body anyway). The bundle-controllers registry section
  documents this flow.
- The AWS SDK `PutObjectCommand.Body` already accepts `string | Uint8Array`
  ([s3-put-controller.ts](../../s3/nodejs/src/s3-put-controller.ts)); the
  controller passes the value through unchanged. `S3.Get` is already binary.

**`S3.Delete` (new kind).** Rounds the module out to a complete object-CRUD set.
Capability `Telo.Invocable`, modelled on `S3.Get`'s typed form:

- `schema`: `bucketRef` (reference to an `S3.Bucket`), same shape as `Get`.
- `inputType`: `{ key: string }`.
- `outputType`: `{ key: string }` (echo the deleted key).
- Controller `#s3-delete` sends `DeleteObjectCommand`. S3 delete is idempotent —
  deleting a missing key is a success, so no `ERR_NOT_FOUND` (only
  `ERR_INVALID_REFERENCE` for an unresolvable `bucketRef`, matching `Get`).
- Add `Delete` to `exports.kinds`.

Docs: update `modules/s3/docs/` for both changes; Docusaurus wiring already
exists for the module. Changie fragment (`Added`); changeset for the
`@telorun/s3` controller (covers the new `s3-delete` entry + the binary `Put`).

## Sequencing

1. **http-server stream body + http-dispatch schema** (keystone).
2. **`std/gzip`** `Gzip.Decoder`.
3. **`std/tar`** `Tar.Decoder`.
4. **`S3`** — binary `Put` widening + new `S3.Delete`.
5. **Release + publish** all of the above to the registry. Only then does the
   registry handler rewrite (bundle-controllers plan) become unblocked.

## Testing

- http-server: a route declaring a stream body receives `Stream<Uint8Array>`;
  AJV is skipped; non-marked routes unchanged. Binary fixture round-trips
  byte-for-byte (no UTF-8 corruption).
- `modules/gzip/tests/*.yaml`: decode a known gzip fixture to expected bytes.
- `modules/tar/tests/*.yaml`: `Tar.Extract` a named entry from a known tar.gz
  fixture (decode chain gzip→tar), assert its bytes; a missing `path` raises
  `ERR_NOT_FOUND`.
- `modules/s3/tests/*.yaml`: put a binary body, get it back unchanged; delete a
  key then assert `Get` raises `ERR_NOT_FOUND`; delete a missing key succeeds
  (idempotent). Against the existing S3 test harness.
- Fixtures under each module's `__fixtures__/`.

## Out of scope

- Encoders (`Gzip.Encoder`, tar writer as a kind) — publish-side compression
  stays in the CLI for now.
- brotli/zstd, zip — future siblings following the same `Decoder` shape.
