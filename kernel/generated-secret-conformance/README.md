# Generated secret conformance vectors

What a kernel answers a `Telo.GeneratedSecretKey` or `Telo.GeneratedPassword` need with, frozen as data: every kernel that hosts the two types reads `vectors.json` and answers each row identically. The values were computed by an implementation written apart from the kernel's, from the rule below alone.

## The derivation

From the host value `TELO_HOST_SECRET_SEED` (32 bytes, unpadded base64url):

1. PRK = HKDF-SHA256-Extract(empty salt, seed).
2. Block *i* (0, 1, …) = HKDF-Expand(PRK, info ‖ 0x00 ‖ uint32be(*i*), 32); the stream is the blocks in order.
3. `info` = `telo/<kind>/<need path>/<parameters>`, the need path `.`-joined (`Auth.sessionKey`) and the parameters the outermost need's, with the type's defaults filled (a set's `minimum` is 0), as RFC 8785 canonical JSON, all as UTF-8.
4. A key is the first `bytes` bytes of the stream in `encoding`'s canonical text: `base64url` unpadded, `base64url-padded`, `base64` (RFC 4648 §4, padded), `hex` lowercase.
5. A password draws with `draw(m)`: the next two stream bytes as a big-endian `v`, accepted when `v < 65536 − 65536 mod m` and yielding `v mod m`, else drawn again. It draws each set's `minimum` characters from that set, sets in written order, then the remaining `length − Σ minimum` from the union (sets, then their characters, in written order), then shuffles: for *i* from `length − 1` down to 1, swap position *i* with `draw(i + 1)`.

## Format

`vectors.json` is `{ "rows": [ … ], "values": [ … ] }`.

- `rows` — the derivation. Each `{ id, seed, kind, path, parameters, value }`: `seed` the seed's text, `kind` the canonical need type, `path` the need path's segments, `parameters` as the need writes them (defaults NOT filled — the runner fills them through the type's schema, so a row omitting `minimum` pins the default), and `value` the field's value.
- `values` — a value supplied in place of the derivation (an env name, a parent's or importer's `needs:` supply, a fulfilment's `fields:`). Each `{ id, kind, parameters, value, refusal }`: `refusal` the rule broken, as the predicate a refusal message ends with (`does not decode as base64url to 32 bytes`), or `null` when the value holds its parameters. A refusal never quotes the value.

## Runners

- `kernel/nodejs/tests/generated-secrets.test.ts` — the Node kernel's derivation and the analyzer's value rules it refuses with.

The Rust kernel refuses `needs:` today and owes a runner when it gains the two types.
