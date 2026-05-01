# Plan: console chat example with streaming OpenAI completions

## Goal

Ship `examples/chat-console.yaml` — an interactive REPL that:

1. Prompts the user for a message at the terminal.
2. Streams the OpenAI assistant reply token-by-token to stdout as it arrives.
3. Persists multi-turn history in a local SQLite file so each turn sees the
   full conversation and the chat survives process restart.
4. Loops until the user types `/exit` (or sends EOF).

## Target manifest (sketch)

```yaml
kind: Telo.Application
metadata: { name: ChatConsole }
targets: [InitSchema, ChatLoop]
---
kind: Telo.Import
metadata: { name: AiOpenai }
source: ../modules/ai-openai
---
kind: Telo.Import
metadata: { name: Ai }
source: ../modules/ai
---
kind: Telo.Import
metadata: { name: RecordStream }
source: ../modules/record-stream     # new package — see P1
---
kind: Telo.Import
metadata: { name: Console }
source: ../modules/console
---
kind: Telo.Import
metadata: { name: JS }
source: ../modules/javascript
---
kind: Telo.Import
metadata: { name: Run }
source: ../modules/run
---
kind: Telo.Import
metadata: { name: Sql }
source: ../modules/sql
---
kind: Sql.Connection
metadata: { name: ChatDb }
driver: sqlite
file: ./chat-history.sqlite
---
kind: Sql.Migration
metadata: { name: CreateMessages }
version: "20260501_create_messages"
sql: |
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
---
kind: Sql.Migrations
metadata: { name: InitSchema }
connection: { kind: Sql.Connection, name: ChatDb }
---
kind: Sql.Query
metadata: { name: SelectHistory }
connection: { kind: Sql.Connection, name: ChatDb }
---
kind: Sql.Exec
metadata: { name: AppendMessage }
connection: { kind: Sql.Connection, name: ChatDb }
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4oMini }
model: gpt-4o-mini
apiKey: "${{ env.OPENAI_API_KEY }}"
options: { temperature: 0.7 }
---
kind: Ai.TextStream
metadata: { name: ChatStream }
model: { kind: AiOpenai.OpenaiModel, name: Gpt4oMini }
system: "You are a helpful CLI assistant. Keep replies brief."
---
kind: RecordStream.ExtractText       # new — see P1
metadata: { name: Deltas }
discriminator: type
records:
  text-delta: { do: emit,  field: delta }
  finish:     { do: drop }
  error:      { do: throw, field: error }
---
kind: Console.WriteStream            # new — see P2
metadata: { name: Stdout }
---
kind: RecordStream.Tee               # new — see P3
metadata: { name: TeeStream }
---
kind: JS.Script                      # builds messages: [...history, {role:'user', content: userText}]
metadata: { name: ComposeMessages }
---
kind: JS.Script                      # drains a Stream<StreamPart>, returns the concatenated assistant text
metadata: { name: CaptureText }
---
kind: Run.Sequence
metadata: { name: ChatLoop }
steps:
  # do-while via shared step name `Read`: pre-loop initializes it; the in-body
  # `Read` overwrites it each iteration. Pattern matches tests/run-sequence-while.yaml.
  - name: Read
    invoke: { kind: Console.ReadLine }
    inputs: { prompt: "you" }
  - while: "${{ steps.Read.result.value != '/exit' }}"
    do:
      - name: ReadHistory
        invoke: { kind: Sql.Query, name: SelectHistory }
        inputs:
          sql: "SELECT role, content FROM messages ORDER BY id ASC"
      - name: InsertUser
        invoke: { kind: Sql.Exec, name: AppendMessage }
        inputs:
          sql: "INSERT INTO messages (role, content) VALUES (?, ?)"
          bindings: ["user", "${{ steps.Read.result.value }}"]
      - name: ComposeMessages
        invoke: { kind: JS.Script, name: ComposeMessages }
        inputs:
          history: "${{ steps.ReadHistory.result.rows }}"
          userText: "${{ steps.Read.result.value }}"
        # returns { messages: [...history, {role:'user', content: userText}] }
      - name: Stream
        invoke: { kind: Ai.TextStream, name: ChatStream }
        inputs:
          messages: "${{ steps.ComposeMessages.result.messages }}"
      - name: Tee
        invoke: { kind: RecordStream.Tee, name: TeeStream }
        inputs:
          input: "${{ steps.Stream.result.output }}"
      - name: Project
        invoke: { kind: RecordStream.ExtractText, name: Deltas }
        inputs:
          input: "${{ steps.Tee.result.outputA }}"
      - name: Print
        invoke: { kind: Console.WriteStream, name: Stdout }
        inputs:
          input: "${{ steps.Project.result.output }}"
      - name: Capture
        invoke: { kind: JS.Script, name: CaptureText }
        inputs:
          input: "${{ steps.Tee.result.outputB }}"
      - name: InsertAssistant
        invoke: { kind: Sql.Exec, name: AppendMessage }
        inputs:
          sql: "INSERT INTO messages (role, content) VALUES (?, ?)"
          bindings: ["assistant", "${{ steps.Capture.result.assistantText }}"]
      - name: Read   # overwrites pre-loop Read so next iteration's predicate sees fresh input
        invoke: { kind: Console.ReadLine }
        inputs: { prompt: "you" }
```

## What's already in place

| Need                                  | Existing primitive                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI streaming completion           | [`Ai.TextStream`](../../modules/ai/telo.yaml) + [`AiOpenai.OpenaiModel`](../../modules/ai-openai/telo.yaml) — emits `Stream<StreamPart>` (text-delta/finish/error) |
| Multi-turn input shape                | `Ai.Model` accepts `messages: [{role, content}]` ([text-messages-array.yaml](../../modules/ai/tests/text-messages-array.yaml))                                    |
| Read a line of stdin                  | [`Console.ReadLine`](../../modules/console/telo.yaml)                                                                                                             |
| REPL-style control flow               | [`Run.Sequence`](../../modules/run/telo.yaml) `while/do`, `if/then`, `try/catch`                                                                                  |
| SQLite persistence                    | [`Sql.Connection`/`Migrations`/`Migration`/`Query`/`Exec`](../../modules/sql/telo.yaml)                                                                           |
| Live OpenAI smoke pattern (reference) | [`openai-live-text-stream.yaml`](../../modules/ai-openai/tests/openai-live-text-stream.yaml)                                                                      |

## Prerequisites

### P1. New `record-stream/` package with `RecordStream.ExtractText`

```yaml
kind: RecordStream.ExtractText
metadata: { name: ... }
discriminator: type            # optional, defaults to 'type'
records:
  <type-tag>: { do: emit,  field: <fieldName> }   # extract record[field] (string), emit downstream
  <type-tag>: { do: drop }                        # silently skip
  <type-tag>: { do: throw, field: <fieldName> }   # throw — message from record[field].message ?? String(record[field])
```

- Capability: `Telo.Invocable`. Inputs: `{input: Stream<record>}`. Outputs:
  `{output: Stream<string>}`.
- Records whose discriminator value isn't listed → throw `ERR_UNKNOWN_RECORD`.
- Tests: cover the three actions (`emit`/`drop`/`throw`) and the
  unknown-type error.

### P2. New `Console.WriteStream`

```yaml
kind: Console.WriteStream
metadata: { name: ... }
# Inputs: { input: Stream<string | Uint8Array> }
# Outputs: none
```

- Drains the stream to `ctx.stdout`. Strings go through Node's native UTF-8
  path; `Uint8Array` chunks pass through. No newline policy.
- Tests: cover both string and `Uint8Array` input shapes, plus the
  empty-stream case.

### P3. `RecordStream.Tee`

Fan one `Stream<T>` out to two `Stream<T>` outputs that each see every item.

```yaml
kind: RecordStream.Tee
metadata: { name: ... }
# Inputs: { input: Stream<T> }
# Outputs: { outputA: Stream<T>, outputB: Stream<T> }
```

- Capability: `Telo.Invocable`. `invoke()` returns the two outputs lazily so
  consumers can be wired up before any iteration begins.
- **Async fan-out semantics.** When one output is iterated ahead of the
  other, items are buffered in memory for the lagging consumer. Bounded by
  the source stream's length; fine for chat-reply-sized streams. (A future
  bounded-buffer / lockstep variant can ship later — out of scope here.)
- Tests: cover sequential drain (consumer A finishes first, then B),
  concurrent drain, error propagation to both outputs, and downstream
  cancellation cleanup.

### P4. `JS.Script` "CaptureText" body

Inline in the example file (not a new module). Drains a `Stream<StreamPart>`
and returns `{assistantText: string}` formed by concatenating every
`text-delta`'s `delta` field. Throws if it sees an `error` part. Source
lives in the example manifest as `code:`.

## Implementation order

1. ~~**Verify CEL list-concat.**~~ **Done.** Findings: list `+` works for
   resolved values (e.g. `[1,2] + [3,4]`), but `@marcbachmann/cel-js` does
   not parse object literals (`{'role': 'user', 'content': ...}`) — those
   pass through as raw strings. Conclusion: the example needs a
   `ComposeMessages` JS step that takes `history` rows + `userText` and
   returns `{messages: [...history, {role: 'user', content: userText}]}`.
   Wired into the manifest sketch in step 5.
2. **P1.** Create `modules/record-stream/` with `RecordStream.ExtractText`
   + tests + docs + changeset. Wire docs into Docusaurus
   (`pages/docusaurus.config.ts` `include` array, `pages/sidebars.ts`
   sidebar entry, `sidebar_label` frontmatter on the markdown file).
3. **P2.** Add `Console.WriteStream` to `modules/console/` + tests + docs +
   changeset. Update `modules/console/README.md` (or the Docusaurus-wired
   docs file if one exists) with the new kind.
4. **P3.** Add `RecordStream.Tee` to `modules/record-stream/` + tests +
   docs + changeset. Same Docusaurus wiring as step 2 if a new docs file
   is added.
5. **Example.** Create `examples/chat-console.yaml` with the SQLite schema,
   the `CaptureText` JS step, and the `Run.Sequence` shown in the manifest
   sketch (single shared `Read` step name, pre-loop + end-of-body, per
   tests/run-sequence-while.yaml pattern). The manifest reads
   `OPENAI_API_KEY` from `env` (Telo loads `.env.local` automatically; the
   user provides the key there at run time).
