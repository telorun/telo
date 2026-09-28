# Controller protocol

One JSON file per message, under `messages/`, read as one lexically ordered set —
the order of the file names compared as UTF-8 bytes. A **message** is one
operation of the Telo controller protocol: either a capability entry point a
kernel calls on a controller, or an operation a controller may ask of a kernel
while inside one.

`generation.json` holds the protocol generation these files describe. It is the
number both carriers report in their handshake and the one an artifact writes as
`abi=telo-<n>`.

The normative document is `kernel/specs/controller-protocol.md`: it says what each
operation MEANS, pins the framed carrier byte-exactly, and carries the inventory
table this directory is checked against. These files say what each operation
CARRIES. `pnpm run check:controller-protocol` fails when the two disagree — in
either direction, and on any cell of any row.

The files live **here**, beside the language halves rather than inside either, for
the reason `sdk/value-types/` and `sdk/zone-attributes/` do: both kernels and every
carrier must agree on the same set, and a set written in one language's code is
readable by one of them. JSON because it is the only format all three runtimes
embed with no generation step — Rust has `include_str!`, Go has `//go:embed`,
TypeScript has neither and only `resolveJsonModule`.

## An entry

| key | meaning |
| --- | --- |
| `name` | `<Group>.<Operation>`, both parts PascalCase. The value the envelope's `type` carries. |
| `direction` | `kernel-to-controller`, `controller-to-kernel` or `either`, read against the protocol's two ends. |
| `spec` | The heading of the spec section this message realises, verbatim and without its `#`s. |
| `request` | JSON Schema of the request payload. |
| `response` | JSON Schema of the **`ok` member** of a response payload — the payload itself is the `ok` / `error` envelope (spec §3.2) — or `null` for a notification, a message for which no response frame is ever sent. |
| `errors` | The protocol error codes this message may answer with. A controller's own declared `throws:` codes cross unchanged and are not listed. |
| `synchronous` | The sender is blocked while the request is outstanding: it performs no other work and reaches no further state until the response arrives. |
| `reentrant` | The responder MAY issue further requests to the sender while this one is outstanding, and the sender MUST serve them. |

**There is no `carriers` key.** "No message exists on one carrier only" is a
property of this directory as a whole, stated once here and proven by
`vectors/carrier-equivalence.json`. A per-entry array listing both carriers would
be the invariant restated in every file at the one place it could be
contradicted — and the first entry to list one would read as a legitimate
exception rather than as the defect it is.

`spec` takes its place, and it is what makes the completeness check
**bidirectional**: every file has a row in the spec's inventory and every row has a
file; every message names a section that exists; and every section the spec's §0
lists as in scope is realised by at least one message.

## The file-name rule

The `name` lowercased, with each `.` and each camel hump becoming `-`:
`Value.Expand` → `value-expand.json`, `Channel.ReadUntil` → `channel-read-until.json`,
`Controller.SinkFlushSync` → `controller-sink-flush-sync.json`. The checker enforces
it, so a file whose name drifts from the message inside it is a failure rather
than a row nothing reads.

## The schema dialect

Every `request` and every `response` schema:

- declares `"$schema": "http://json-schema.org/draft-07/schema#"`;
- keeps every `$ref` **internal to its own file** (`#/definitions/…`), so a
  validator needs no resolver and no base URI;
- uses **no `format` as an assertion** — a constraint is spelled with `pattern`.

All three are checked. They exist because "validated against its schema" has to be
the same claim under two different validators in two languages: an unpinned
dialect, an external `$ref` and `format` are the three places where two conforming
validators legitimately disagree, and each would turn a conformance assertion into
an accident of which library was wired in.

Values inside a payload are **typed frames** (`kernel/specs/durable-execution.md`
§6). A schema here describes the frame's *decoded* value, so a slot holding bytes
is a value of CEL type `bytes` rather than a string a reader must know to decode.

## The set is closed

A module cannot contribute a message. Every reader of this directory is a kernel
or a carrier, and every message exists because some kernel must implement it on
both carriers and some controller must be able to count on it — a third-party
entry would be half a message: data with no implementation on either side, and no
vector proving the two carriers agree about it.

**Adding a message is a generation bump.** The generation is a complete message
set, which is why the handshake refuses a mismatch instead of negotiating down: a
kernel that spoke "generation 4 minus two messages" would fail at the moment a
controller reached for one, arbitrarily far from the pairing that accepted it.

## Where the conformance vectors live, and why not in `kernel/specs/`

**Conformance vectors live with the artifact set they conform; when a contract's
only artifact is its spec, that is beside the spec.** The typed frame's contract
is its spec's own tables, so its vectors sit beside that spec. The layer index's
contract is `analyzer/artifact-axes/axes.json`, so its vectors sit beside that.
This protocol's contract is this directory — the message set, the generation, and
the closedness and carrier-equivalence claims above — so its vectors sit here:

- `vectors/framing.json` — byte-exact encode and decode of every frame, and the
  frames a reader refuses.
- `vectors/messages.json` — every request and response body against its schema,
  with each invalid row naming the RFC 6901 **instance** pointer the refusal
  reports.
- `vectors/sequences.json` — whole exchanges: correlation, the reentrancy
  interleave, channel credit and ordering, signals against errors.
- `vectors/carrier-equivalence.json` — the framed row's payload region and the ABI
  row's buffer are the same bytes, the framed side adding only its header.

One runner in each language executes all four, and neither has a skip path.

## No barrel, no copy script

Nothing under `sdk/nodejs` reads these files, so there is no `prepare` step
copying them in and no generated index. A reader reads the directory. When a
consumer inside a published package needs them, it gets a copy step then — a
generated barrel nothing imports is surface with no reader.

`cli/nodejs/Dockerfile.dockerignore` allowlists `!sdk/controller-protocol`, the
**directory** and never a subdirectory. That is an obligation rather than a
reason: a per-subdirectory allowlist is exactly what once shipped a CLI image with
no value types in it at all.
