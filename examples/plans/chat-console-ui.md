# Plan: chat-console UI polish

## Goal

Make `examples/chat-console.yaml` feel like an interactive chat session
rather than a raw REPL:

1. The user's prompt and the assistant's reply are visually distinct without
   relying on ANSI escape codes.
2. While waiting for the first AI token, an inline animated indicator shows
   that something is happening.
3. The output remains readable when piped or copy-pasted out of the terminal.

## Why no ANSI colors

ANSI escape sequences (`[36m…[0m`) only render correctly inside
a TTY. Three concrete problems for an example app:

- Piped output (`telo … | tee log.txt`) captures literal `[36m…` junk.
- Windows consoles and remote shells handle escapes inconsistently.
- Copy-pasting transcripts into chat / docs / issues drags the escapes along
  unless the terminal happens to strip them.

A modern chat CLI can look great without color. The visual cues we need —
"who is talking" + "something is happening" — can be carried by **Unicode
glyphs**, **layout** (indentation, line returns), and **plain animation via
`\r`** (carriage return, universal, not an ANSI escape).

## Visual design (proposed)

```
you › hi there
ai  › Hello! How can I help you today?
you › what's the time?
ai  › I don't have access to real-time data, but you could check…
you › /exit
```

- **`you ›`** — user input prompt. Right-pointing chevron `›` (U+203A)
  doubles as a "this is what you typed" anchor.
- **`ai  ›`** — assistant label, two characters wide ("ai") plus an extra
  space so the chevron column-aligns with `you ›`. Same chevron makes the
  pairing obvious.
- The chevron alone (no `:`) is the entire suffix — no `you›: hi`-style
  collision.
- Blank line between turns is dropped (column-aligned chevrons already
  separate them visually).

**Spinner**: appears immediately after `ai  › ` while waiting for the first
token, then is overwritten in place when streaming starts.

```
ai  › ⠋
ai  › ⠙
ai  › ⠹
ai  › Hello! How can I…
```

Frame set: braille dot cycle `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (8-step, single-cell wide,
universal in modern monospace fonts; ASCII fallback `|/-\` if we want zero
font dependency). 80 ms tick.

**Mechanism — reserved cell with `\b` parking**: the column the spinner
occupies is reserved up-front by writing a placeholder space and immediately
backing the cursor up over it. From then on, every spinner tick is just
`frame + \b` (write the glyph, return cursor to the same column) — two
bytes per tick, no `\r`, no full-label repaint. Stop writes `' \b'` (clear
the cell with a space, cursor stays at the same column). Pure C0 control
characters; no ANSI escapes anywhere.

```text
init  : LABEL ' \b'    →  prints "ai  › ", then space at col 6, cursor parked at col 6
tick  : frame '\b'      →  glyph at col 6, cursor back to col 6 (overwrites previous frame)
stop  : ' \b'           →  space at col 6 clears whatever frame was last drawn, cursor at col 6
```

After stop, the next downstream item writes at column 6 over a
freshly-cleared cell.

## Required changes

### C1. `Console.ReadLine` — drop the auto-suffix

Today the controller hardcodes `iface.question(\`${prompt}: \`, …)`. The
auto-`": "` is an opinion baked into the controller — convenient for
shell-style prompts, but every other prompt shape has to fight it. Drop
the auto-suffix: `prompt` is printed character-for-character.

```yaml
kind: Console.ReadLine
prompt: "you › "
```

Single field, full control, no magic. Schema unchanged (still just
`prompt: string`, required). One-line controller change in
[readline-controller.ts](../../modules/console/nodejs/src/readline-controller.ts):
`iface.question(\`${prompt}: \`, …)` → `iface.question(prompt, …)`.

Behavior change for `@telorun/console`. Minor bump (package is at
`0.2.0` — pre-1.0, semver permits breaking changes in minor). Migration
list (verified via repo grep for `kind: Console.ReadLine` callers):

- [examples/console-user-input.yaml](../../examples/console-user-input.yaml)
  — two `prompt:` fields (`Username`, `Password`), append `": "` to each.
- [examples/chat-console.yaml](../../examples/chat-console.yaml) — both
  `prompt: "you"` occurrences (handled by C5 below; listed here so the
  full migration scope is visible up front).

No test manifests use `Console.ReadLine` today.

Changeset must enumerate the behavior change explicitly so consumers
upgrading discover it.

### C2. New stdlib resource: `Console.StreamWait`

Stream passthrough that animates a single-cell frame sequence on stdout
while waiting for the first item from its input, then clears the cell
and forwards every item unchanged. The contract is right there in the
name: it's an animation **scoped to the stream-wait lifecycle**.
Spinner-style frames are just one usage — the same primitive supports
pulsing dots (`.`, ` `), blinking cursors (`█`, ` `), single-character
"thinking" indicators, etc., as long as each frame is one cell wide.

Lives in [modules/console/](../../modules/console/) because the side
effect is on `ctx.stdout`; it's a transformer in shape but fits the I/O
package's domain.

Why the name carries `StreamWait`: an animation needs a stop trigger to
be useful, and Telo today only has stream-first-item as a clean trigger
(no signal/event mechanism). Naming the kind `Console.Animation` would
imply genericity the controller can't deliver. If/when Telo gains
runnable-wrap or signal-stop primitives, parallel kinds (`Console.RunnableWait`,
`Console.SignalWait`, …) can ship alongside this one.

**Schema:**

```yaml
kind: Telo.Definition
metadata: { name: StreamWait }
capability: Telo.Invocable
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      input:
        x-telo-stream: true
        description: Async iterable to forward; spinner runs until the first item arrives.
    required: [input]
    additionalProperties: false
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      output:
        x-telo-stream: true
        description: |
          Forwarded stream — interleaved with prefix, spinner frames, and
          a clear sequence at the head, then every input item verbatim.
    required: [output]
    additionalProperties: false
schema:
  type: object
  properties:
    prefix: { type: string, default: "" }
    frames:
      type: array
      minItems: 1
      items: { type: string, minLength: 1, maxLength: 1 }
      default: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
    intervalMs: { type: integer, minimum: 16, default: 80 }
  additionalProperties: false
```

- Capability: `Telo.Invocable`.
- Inputs: `{ input: Stream<T> }`. Outputs: `{ output: Stream<T> }`.
- `outputType` carries `x-telo-stream: true` so the analyzer's chain
  validator forbids `.field` access past `result.output` (mirrors
  `RecordStream.ExtractText`'s shape).
- **Validation rules** (controller, at create time):
  - `frames`: each entry must be a single JS code unit (`length === 1`).
    Documented constraint: each frame should occupy **one terminal cell**.
    Multi-cell glyphs (CJK, emoji with VS16, combining marks) are not
    runtime-validated — picking a width-1 glyph is the manifest author's
    responsibility. Going further would pull in `string-width`/`wcwidth`
    and isn't worth the dependency for a stdlib primitive.
  - `prefix`: must not contain `\n`, `\r`, `\b`, or `\x1b`. These would
    desync the cursor-parking trick. Markup tags are fine — they're
    rendered by the downstream sink (see C3) and produce printable text.
    Unknown-width characters (CJK, emoji) in `prefix` aren't rejected,
    but if the manifest author picks a multi-cell prefix the cursor
    position is undefined and the visual will misalign. Documented, not
    runtime-enforced (same reason as `frames`).

**Controller sketch (single-writer-via-stream):**

The controller does **not** write to `ctx.stdout` directly. All bytes are
yielded into the output stream and the downstream `Console.WriteStream`
remains the sole stdout writer. This eliminates two leak/race classes:

- **Uniterated generator → no leak.** `setInterval` would have started in
  `invoke()` itself; if the consumer never iterates the result (e.g. a
  step between `Spin` and `Print` errors before pulling), the interval
  never fires `clearInterval`. With the new shape, the timer lives
  inside the generator function — it's only created once iteration
  begins, and `try/finally` covers every termination path.
- **Two-writer races → impossible.** Frames, clear sequences, and
  forwarded items are interleaved into a single byte stream that the
  one downstream writer consumes in order. No microtask-ordering
  uncertainty between `ctx.stdout.write(' \b')` from the controller and
  `ctx.stdout.write(<token>)` from `Console.WriteStream`.

```ts
async invoke(inputs: Inputs): Promise<Outputs> {
  const { prefix = "", frames = DEFAULT_FRAMES, intervalMs = 80 } = this.resource;
  const source = inputs.input;

  async function* gen(): AsyncIterable<string> {
    // Reserve the spinner cell. ' \b' = space at col N, cursor parked at col N.
    yield prefix + " \b";
    // Paint frame 0 immediately so there's no 80 ms blank gap before the
    // animation starts (setInterval fires *after* the first interval).
    yield frames[0] + "\b";

    const reader = source[Symbol.asyncIterator]();
    const firstPull = reader.next();

    let i = 1;
    let firstResult: IteratorResult<unknown> | undefined;
    let activeTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      while (firstResult === undefined) {
        const sleep = new Promise<void>((r) => {
          activeTimer = setTimeout(() => { activeTimer = null; r(); }, intervalMs);
        });
        const winner = await Promise.race([
          firstPull.then((r) => ({ kind: "first" as const, r })),
          sleep.then(() => ({ kind: "tick" as const })),
        ]);
        if (winner.kind === "first") {
          firstResult = winner.r;
        } else {
          yield frames[i++ % frames.length] + "\b";
        }
      }
    } finally {
      if (activeTimer !== null) clearTimeout(activeTimer);
    }

    // Clear the spinner cell.
    yield " \b";

    if (firstResult.done) return;
    yield firstResult.value as string;

    while (true) {
      const next = await reader.next();
      if (next.done) return;
      yield next.value as string;
    }
  }

  return { output: new Stream(gen()) };
}
```

**Responsibilities:**

1. Yield `prefix + " \b"` to reserve the animation cell with the cursor parked.
2. Yield `frames[0] + "\b"` synchronously to fill the first frame immediately.
3. Race `firstPull` (input's first item) against a `setTimeout(intervalMs)`;
   on tick wins, yield the next frame; on first-item win, exit the wait loop.
4. Yield `" \b"` to clear the cell.
5. Forward every input item unchanged (passthrough after stop).
6. `try/finally` clears any pending `setTimeout` if the generator's
   `return()` is called early (consumer break, downstream throw).

**Why generic:**

- No domain knowledge baked in (`prefix` is opaque, `frames` configurable).
- Reusable for any "stream is loading" CLI scenario — HTTP response
  streaming, large file read, queue drain, AI completion.
- Composes cleanly: drop it on any `Stream<T> → Stream<T>` pipeline edge
  where the consumer wants visual feedback during latency.

**Package change:** new kind in `console/`, additive, minor bump on
`@telorun/console`. New changeset.

**Tests:** smoke test with a JS source that yields after a controlled delay,
verify the spinner-then-passthrough behaviour by capturing `ctx.stdout`
into a buffer (the controller takes `ctx.stdout` so tests can inject a
fake writable).

### C3. Console-internal color markup

A small markup language interpreted by every text-emitting `Console.*`
sink (`WriteLine`, `WriteStream`, `ReadLine.prompt`, `StreamWait.prefix`).
**Lives entirely inside `console/`** — no separate package, no
cross-cutting type, no runtime tag in the schema. Each console controller
runs strings through one tiny render helper before writing.

**Syntax:** chalk-template-style `{style content}`.

```text
{red error}                      → red text "error"
{red.bold ERROR}                 → red bold "ERROR"
{red.bgWhite warning}            → red on white "warning"
{#ff8800 highlight}              → hex foreground "highlight"
{cyan you} › {dim hint}          → mixed inline
hi {red {bold WORLD}!}           → nested
literal: \{red\} not a tag       → escaped braces (literal output)
```

**Grammar (terse):**

```text
TAG          = '{' STYLE_CHAIN WS CONTENT '}'
STYLE_CHAIN  = STYLE ('.' STYLE)*
STYLE        = COLOR | ATTRIBUTE | BG | HEX
COLOR        = 'red' | 'green' | 'blue' | 'cyan' | 'magenta' | 'yellow' | 'white' | 'black' | 'gray'
              (+ 'bright<Color>' variants — brightRed, brightGreen, …)
ATTRIBUTE    = 'bold' | 'dim' | 'italic' | 'underline' | 'reverse' | 'strikethrough'
BG           = 'bg' COLOR        # bgRed, bgWhite, …
HEX          = '#' [0-9a-fA-F]{6}
ESCAPE       = '\{', '\}', '\\'  # literal '{', '}', '\'
```

**Rules:**

- Every `{` opens a tag; the next whitespace separates the style chain
  from the content; the matching `}` closes the tag.
- Tags nest LIFO. `{red {bold X}}` is well-formed.
- Unbalanced or unknown styles → render as literal text, swallow the
  markup-parse error (don't crash the consumer over a typo). Emit a
  `Console.MarkupParseError` event for observability.
- Disambiguation from CEL: CEL spans are bracketed by `${{ … }}` (dollar
  + double brace). Markup is `{ … }` (single brace, no `$` prefix). CEL
  evaluation runs first (existing pipeline); markup parsing runs at sink
  write time on the post-CEL string. No collision at any layer.

**Render rules:**

- **TTY sink** (`process.stdout.isTTY === true`): emit ANSI SGR codes.
  16-color baseline (`\x1b[31m` etc.); 256-color and truecolor where
  `COLORTERM` indicates support.
- **Non-TTY sink** (piped, redirected): strip all markup, emit plain text.
  Hex colors and ANSI attributes vanish; content survives verbatim.
- Detection happens once per controller invocation by checking the
  underlying `ctx.stdout` (Node `WriteStream.isTTY`).

**Implementation footprint** (Node only — Rust/Go ports later if/when
those engines exist for `console/`):

- New file: `modules/console/nodejs/src/markup.ts`. Two exports: `parse(s: string): Token[]` and `render(s: string, tty: boolean): string`. ~80–120 LOC.
- All four touchpoints (`WriteLine.output`, `WriteStream` chunks, `ReadLine.prompt`, `StreamWait.prefix`) call `render(value, this.ctx.stdout.isTTY)` immediately before `ctx.stdout.write(...)`.
- One unit test file covering: solo styles, chained styles, nesting,
  escapes, unknown style fallback, hex, TTY-vs-non-TTY render parity.

**Package change:** internal helper, no schema change. Folds into the
same `@telorun/console` minor bump as C1. Note for migration: any
existing manifest with literal `{…}` inside a console output string will
now have those braces interpreted as markup tags — escape via `\{ \}` to
preserve the previous behaviour. Unlikely in practice.

### C4. Pipeline rewiring

Declare a `Console.StreamWait` resource and insert it between `Project`
and `Print` in the loop body. **Keep the trailing `Newline` step.**

Why the `Newline` step is required: Node's `readline` interface in TTY
mode treats `iface.question(prompt)` as a line refresh — it emits `\r`
+ `\x1b[K` (cursor-home + clear-to-end-of-line) before writing the
prompt. If the cursor is mid-line at the moment `Read` runs, the
assistant's reply that was sitting on that line gets *erased*:

```text
ai  › The weather is sunny.[cursor]   ← assistant just finished
you ›                                  ← readline clears the line, prompt sits where the assistant text was
```

A prior draft of this plan claimed `readline.createInterface` would
move to a fresh line automatically; that assumption was wrong (verified
empirically). The single-line `Console.WriteLine { output: "" }` step
emits exactly one `\n`, putting the cursor at column 0 of the next
line, which means the readline refresh has nothing to erase. Cost: one
manifest step + one stdout newline byte per turn.

```yaml
kind: Console.StreamWait
metadata: { name: ChatSpinner }
prefix: "{magenta.bold ai}  › "
```

Body:

```text
ReadHistory → InsertUser → ComposeMessages → Stream → Tee
  outputA → Project → ChatSpinner → Print
  outputB → Capture → InsertAssistant → Read
```

(One step shorter than the current loop body; no inline JS.)

### C5. Update the manifest's `Read` step

```yaml
- name: Read
  invoke:
    kind: Console.ReadLine
    prompt: "{cyan.bold you} › "
```

Same change for the in-loop `Read` at the end of the body. The `›`
chevron stays plain (or wrap it `{dim ›}` if we want a faded look —
that's a tiny aesthetic call).

## Resulting manifest (excerpt)

Putting C1–C5 together, the relevant parts of `examples/chat-console.yaml`
end up looking like this. Top-level resource declarations:

```yaml
kind: Console.StreamWait
metadata: { name: ChatSpinner }
prefix: "{magenta.bold ai}  › "
# frames + intervalMs use defaults (braille spinner, 80 ms)
```

Loop body inside the `ChatLoop` `Run.Sequence`:

```yaml
- name: Read
  invoke:
    kind: Console.ReadLine
    prompt: "{cyan.bold you} › "
- name: Loop
  while: "${{ steps.Read.result.value != '/exit' }}"
  do:
    - name: ReadHistory
      inputs:
        sql: "SELECT role, content FROM messages ORDER BY id ASC"
      invoke:
        kind: Sql.Query
        connection: { kind: Sql.Connection, name: ChatDb }
    - name: InsertUser
      inputs:
        sql: "INSERT INTO messages (role, content) VALUES (?, ?)"
        bindings: ["user", "${{ steps.Read.result.value }}"]
      invoke:
        kind: Sql.Exec
        connection: { kind: Sql.Connection, name: ChatDb }
    - name: ComposeMessages
      invoke: { kind: JS.Script, name: ComposeMessages }
      inputs:
        history: "${{ steps.ReadHistory.result.rows }}"
        userText: "${{ steps.Read.result.value }}"
    - name: Stream
      invoke: { kind: Ai.TextStream, name: ChatStream }
      inputs:
        messages: "${{ steps.ComposeMessages.result.messages }}"
    - name: Tee
      invoke: { kind: RecordStream.Tee, name: ModelTee }
      inputs:
        input: "${{ steps.Stream.result.output }}"
    - name: Project
      invoke: { kind: RecordStream.ExtractText, name: Deltas }
      inputs:
        input: "${{ steps.Tee.result.outputA }}"
    - name: Spin                                  # NEW — animated wait
      invoke: { kind: Console.StreamWait, name: ChatSpinner }
      inputs:
        input: "${{ steps.Project.result.output }}"
    - name: Print
      invoke: { kind: Console.WriteStream, name: Stdout }
      inputs:
        input: "${{ steps.Spin.result.output }}"
    - name: Capture
      invoke: { kind: JS.Script, name: CaptureText }
      inputs:
        input: "${{ steps.Tee.result.outputB }}"
    - name: InsertAssistant
      inputs:
        sql: "INSERT INTO messages (role, content) VALUES (?, ?)"
        bindings: ["assistant", "${{ steps.Capture.result.assistantText }}"]
      invoke:
        kind: Sql.Exec
        connection: { kind: Sql.Connection, name: ChatDb }
    - name: Newline                                # required — readline TTY refresh
      invoke:                                      # would otherwise erase the assistant's
        kind: Console.WriteLine                    # reply when re-prompting on the same line
        output: ""
    - name: Read
      invoke:
        kind: Console.ReadLine
        prompt: "{cyan.bold you} › "
```

### Sample interaction (TTY)

What the user sees in an interactive terminal — `{cyan you}` renders as
cyan-bold, `{magenta ai}` as magenta-bold, the spinner cycles through
braille frames during the ~500 ms TTFB, then disappears as the first
token arrives:

```text
you › what's the difference between TCP and UDP?
ai  › ⠋                              ← spinner while waiting for first token
ai  › TCP is connection-oriented and reliable; UDP is connectionless and
fire-and-forget. TCP guarantees delivery and order, UDP doesn't — which
is why UDP is preferred for low-latency use cases like video streaming.
you › thanks
ai  › You're welcome! Let me know if there's anything else.
you › /exit
```

(Color is applied to the chevron-prefixed labels in a TTY; piped output
strips it. The `›` chevron and label text stay column-aligned across
turns, giving the conversation a clean visual rhythm without horizontal
rules or blank-line separators.)

### Sample interaction (piped, e.g. `telo … | tee chat.log`)

Markup is stripped at write time when `process.stdout.isTTY === false`.
The transcript stays readable:

```text
you › what's the difference between TCP and UDP?
ai  › TCP is connection-oriented and reliable; UDP is connectionless and
fire-and-forget. TCP guarantees delivery and order, UDP doesn't — which
is why UDP is preferred for low-latency use cases like video streaming.
you › thanks
ai  › You're welcome! Let me know if there's anything else.
you › /exit
```

(Spinner frames appear during piped output too — the `\b` parking is
just bytes in the file, surrounded by literal spaces — the visual is
imperfect but the transcript is still parseable line-by-line.)

## Tradeoffs and caveats

- **Glyph rendering depends on the terminal font.** Modern monospace
  fonts (DejaVu Sans Mono, Cascadia Code, JetBrains Mono, SF Mono, …) all
  ship Braille and chevrons. If we want zero font risk, fall back to ASCII
  spinner `|/-\` and `>` as the chevron — same plan, dumber glyphs.
- **`\b` cursor parking assumes a TTY-like terminal that handles
  backspace.** Every interactive shell does. Piping into a file or to
  `cat` produces literal `\b` characters in the output — for an
  interactive example this is acceptable; mention it in the example's
  description.
- **Spinner frames stop counting if the first token arrives between
  ticks.** Acceptable — typical OpenAI TTFB is 300–800 ms, easily
  enough to see at least one frame transition. Frame 0 paints
  immediately (no 80 ms blank gap) so the spinner is visible from the
  first byte even on fast responses.
- **Single stdout writer.** Frames, clear sequences, and forwarded items
  are all yielded as bytes into the output stream; the only resource that
  writes to `ctx.stdout` is the downstream `Console.WriteStream`. No
  multi-writer race possible. (Earlier draft had `Console.StreamWait`
  writing to stdout directly — that was leaky on uniterated-generator
  paths and racy on cleanup; revised to the stream-yield architecture
  before this version of the plan.)

## Implementation order

1. **C1** — `Console.ReadLine` drops the auto-`": "` suffix. One-line
   controller change + migrate both in-tree consumers
   ([examples/console-user-input.yaml](../../examples/console-user-input.yaml)
   and [examples/chat-console.yaml](../../examples/chat-console.yaml))
   + tests.
2. **C3** — markup parser + renderer in
   `modules/console/nodejs/src/markup.ts`. Wire `render()` into all
   four sink touchpoints (`WriteLine.output`, `WriteStream` chunks,
   `ReadLine.prompt`, `StreamWait.prefix` — though StreamWait doesn't
   exist yet, the contract is set so step 3 just calls the helper).
   Unit tests for the parser + TTY/non-TTY render parity. **Docs**:
   create `modules/console/docs/markup.md` (or fold into
   `modules/console/README.md`); add `sidebar_label` frontmatter; add
   sidebar entry to [pages/sidebars.ts](../../pages/sidebars.ts) under
   the Console category. The Docusaurus `include` array auto-derives
   from sidebars (per [pages/docusaurus.config.ts](../../pages/docusaurus.config.ts):collectDocIds),
   so no manual entry there.
3. **C2** — new `Console.StreamWait` kind in
   [modules/console/telo.yaml](../../modules/console/telo.yaml) +
   controller in `modules/console/nodejs/src/streamwait-controller.ts` +
   tests. Test strategy: drive a delayed-yield source, collect the
   resulting output stream into a string, assert the byte sequence
   matches `<prefix> <space> \b <frame0> \b ... <space> \b <items>`.
   Markup-render parity is exercised by the C3 tests; here we only
   verify the byte interleaving. **Docs**: new
   `modules/console/docs/stream-wait.md` (kind page) with frontmatter +
   sidebar entry under the Console category in
   [pages/sidebars.ts](../../pages/sidebars.ts).
4. **Bundle into one minor bump** of `@telorun/console`: C1 (ReadLine
   semantics tweak), C2 (new kind), C3 (markup interpretation). One
   changeset enumerating all three; the changeset description must
   call out the literal-`{` migration path (`\{ \}` escapes) since
   that's the silent behaviour change for any pre-existing manifest.
5. **C4 + C5** — update `examples/chat-console.yaml`: declare the
   spinner with markup-styled prefix, wire it into the body (the
   `Newline` step *stays* — see C4 above for why), update the `Read`
   steps to use the colored prompt. No package changes; examples
   aren't published.
6. **Smoke test** — manual: real OpenAI key, verify chevrons align,
   spinner runs and clears, first frame appears immediately (not after
   80 ms), colors render in a TTY, plain text when piped into
   `tee log.txt` (verify the file is markup-free and readable).
   Multi-turn flow + `/exit` work cleanly.

## Out of scope (orthogonal cleanup)

`Console.ReadLine`'s declared capability is `Telo.Runnable` but its
shape — accepts inputs at invoke time, returns a `{value: string}`
result — is `Telo.Invocable`. Consistent with how `Run.Sequence` already
treats it, but worth correcting in a follow-up. Not bundled into this
plan to keep the breaking-change surface small and focused.

## Resolved decisions

- **Braille spinner + Unicode chevron `›`** as the visual baseline. Modern
  fonts ship both; if a user runs in a font without them they can override
  `frames` on the `Console.StreamWait` resource and rewrite the prompt
  strings — no plan change needed.
- **`Newline` step retained** — see C4 above. Earlier draft claimed it
  could be dropped because `readline.createInterface` would move to a
  fresh line automatically; that was wrong (TTY refresh erases the
  current line on `iface.question`). The single-line `WriteLine` step
  is required to push the cursor past the assistant's reply.
- **No indentation for multi-line assistant continuations.** The model
  occasionally emits `\n`-separated paragraphs; those wrap naturally to
  column 0 of the next line. Indenting under `ai  › ` would need an
  extra string-stream transformer and complicates the pipeline; not
  worth it for v1. Wrapped lines are still readable.
