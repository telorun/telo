---
description: "Console I/O: Console.WriteLine writes output lines, Console.ReadLine reads stdin with a prompt, Console.WriteStream drains a stream of strings or bytes to stdout. All accept inline `{red text}` markup that renders as ANSI on a TTY and plain text when piped."
sidebar_label: Console
---

# Console

Direct access to the process's standard streams. Useful for CLI-style manifests, interactive demos, and tests that want to print without a logger layer.

`WriteLine` and `ReadLine` are `Telo.Runnable` — they execute once when their position in a `Run.Sequence` (or as an Application `target`) is reached. `WriteStream` is `Telo.Invocable` — it drains a stream provided as `input`.

Every `Console.*` text path interprets a small `{style content}` markup language at write time (see [Markup](#markup) below). Markup renders as ANSI SGR codes when the underlying stdout is a TTY; otherwise it's stripped to plain text. `ReadLine.prompt` is rendered character-for-character — there is no auto-appended `: ` suffix.

---

## Console.WriteLine

Writes `output` to stdout followed by a newline.

```yaml
kind: Console.WriteLine
metadata:
  name: Greet
output: "Hello, ${{ inputs.name }}!"
```

`output` supports `${{ }}` templating like any other runtime field — variables, secrets, resource snapshots, and (inside a `Run.Sequence`) `steps.<name>.result` are all in scope.

---

## Console.ReadLine

Reads a single line from stdin. The `prompt` field is written to stdout
character-for-character — no trailing newline, no auto-appended `: ` —
so the caret stays on the same line wherever you put it.

```yaml
kind: Console.ReadLine
metadata:
  name: AskName
prompt: "What's your name? "
```

The captured value surfaces via the runnable's result. The usual pattern
is to wrap `Console.ReadLine` inline in a `Run.Sequence` step:

```yaml
kind: Run.Sequence
metadata:
  name: Greeter
steps:
  - name: Ask
    invoke:
      kind: Console.ReadLine
      prompt: "Name: "
  - name: Greet
    invoke:
      kind: Console.WriteLine
      output: "Hello, ${{ steps.Ask.result.value }}!"
```

Markup tags inside `prompt` are rendered at write time. On a TTY,
`prompt: "{cyan you} › "` shows the label in cyan; piped to a file
the same prompt is plain text.

---

## Console.WriteStream

Drains a `Stream<string | Uint8Array>` to stdout. Strings go through Node's native UTF-8 path; `Uint8Array` chunks pass through unchanged. No newline policy — producers control framing.

```yaml
kind: Console.WriteStream
metadata:
  name: Stdout
```

Inside a `Run.Sequence`, wire an upstream stream to the resource's `input`:

```yaml
- name: Print
  invoke: { kind: Console.WriteStream, name: Stdout }
  inputs:
    input: "${{ steps.SomeProducer.result.output }}"
```

`WriteStream` pairs naturally with text producers like `RecordStream.ExtractText` (`Stream<string>`) and with byte-producing codecs like `Ndjson.Encoder` / `Sse.Encoder` / `Octet.Encoder` (`Stream<Uint8Array>`) — both shapes are accepted on the same input contract.

---

## Console.StreamWait

Stream passthrough that animates a single-cell frame sequence on stdout while waiting for the first item from its input, then clears the cell and forwards every item unchanged. Useful for "loading" indicators in CLI flows where the next step is a stream that has measurable startup latency (HTTP requests, AI completions, file reads, queue drains).

```yaml
kind: Console.StreamWait
metadata:
  name: ChatSpinner
prefix: "{magenta.bold ai}  › "       # markup rendered at sink time
# frames: defaults to braille spinner
# intervalMs: defaults to 80 ms
```

```yaml
- name: Spin
  invoke: { kind: Console.StreamWait, name: ChatSpinner }
  inputs:
    input: "${{ steps.SomeProducer.result.output }}"
- name: Print
  invoke: { kind: Console.WriteStream }
  inputs:
    input: "${{ steps.Spin.result.output }}"
```

The contract is right there in the name: it's an animation **scoped to the stream-wait lifecycle**. Every byte emitted by `StreamWait` flows through its output stream — the resource never writes to stdout directly. The downstream sink (typically `Console.WriteStream`) is the sole writer, so there's no two-writer race.

### Reserved-cell mechanics

The animation occupies one cell, reserved by the head of the output:

```text
prefix       ← written verbatim (with markup rendered if TTY)
' \b'        ← reserve the next column with a space, park the cursor on it
frames[0]+\b ← initial frame, painted immediately (no `intervalMs` blank gap)
… ticks …   ← each tick: frame[i] + \b, overwriting the same cell
' \b'        ← clear the cell when first input item arrives
items…       ← every input item forwarded verbatim, starting at the cleared column
```

### Field reference

| Field        | Default                             | Notes                                                           |
| ------------ | ----------------------------------- | --------------------------------------------------------------- |
| `prefix`     | `""`                                | Markup-aware. Must not contain `\n` `\r` `\b` `\x1b`.            |
| `frames`     | `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]` | Each frame must be exactly one character (`length === 1`).      |
| `intervalMs` | `80`                                | Tick period. Minimum 16.                                        |

### Caveats

- `\b` cursor parking assumes a TTY-like terminal. Piped output captures the literal `\b` bytes — readable but not visually clean.
- Frames are validated as single-character strings; **terminal cell width** isn't checked. If you pick a CJK character or emoji with VS16, the visual will misalign — pick width-1 glyphs (Braille, ASCII, simple punctuation).
- Same goes for `prefix`: control chars are rejected, but multi-cell glyphs aren't validated.

---

## Markup

Every `Console.*` text path runs strings through a tiny chalk-template-style
markup parser before writing. On a TTY (`process.stdout.isTTY === true`) tags
become ANSI SGR codes; otherwise the markup is stripped to plain text. The
manifest author writes one source string; the right thing happens at the sink.

### Syntax

```text
{red error}                 red foreground
{red.bold ERROR}             dot-chained styles
{red.bgWhite warning}        background via bgRed / bgWhite / …
{#ff8800 highlight}          truecolor hex foreground
{bg#222244 banner}           truecolor hex background
hi {red {bold WORLD}!}       nesting (LIFO)
literal: \{red\} not a tag   escaped braces — backslash also escapes itself
```

### Recognized styles

| Category   | Names                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Foreground | `black` `red` `green` `yellow` `blue` `magenta` `cyan` `white` `gray` (also `grey`)                              |
| Bright fg  | `brightBlack` `brightRed` `brightGreen` `brightYellow` `brightBlue` `brightMagenta` `brightCyan` `brightWhite`   |
| Background | `bgBlack` `bgRed` `bgGreen` `bgYellow` `bgBlue` `bgMagenta` `bgCyan` `bgWhite` `bgGray` (+ `bgBright<Color>`)    |
| Hex        | `#RRGGBB` (foreground), `bg#RRGGBB` (background)                                                                 |
| Attribute  | `bold` `dim` `italic` `underline` `reverse` `strikethrough`                                                      |

### Behaviour

- **Open–close pairing.** Every `{` opens a tag; the next whitespace separates
  the style chain from the content; the matching `}` closes the tag. Tags
  must be balanced and properly nested (LIFO).
- **Unknown styles fall through to literal.** A typo (`{notARealStyle hi}`)
  or a future grammar addition this implementation doesn't yet recognize
  renders the entire tag as literal text — the consumer sees what they
  wrote, no crash.
- **Same-axis nesting reverts to default on inner close.** `{red {green X}} more`
  emits red, then green, then resets foreground to terminal default
  (not back to red). Avoid nesting same-axis styles; nest cross-axis
  instead (`{red {bold X}} more red` is fine — bold and color are independent).
- **CEL coexists.** `${{ … }}` (dollar + double brace) is CEL; `{ … }`
  (single brace, no `$`) is markup. CEL evaluation runs first; markup
  runs at sink write time on the post-CEL string.

### Render targets

- **TTY**: ANSI SGR codes. 16-color baseline + 256-color and truecolor
  for hex variants.
- **Non-TTY** (piped, redirected): all markup stripped, content emitted
  verbatim.

Detection happens once per controller invocation by checking
`ctx.stdout.isTTY`. No environment variables, no `--color` flag plumbing
required.

---

## Notes

- Intended for the root Application process. When a kernel runs inside a non-interactive environment (a detached container, a Temporal worker), `Console.ReadLine` will block indefinitely — wrap it with an outer sequence that only runs in interactive contexts.
- Output is unbuffered line-by-line. Each `Console.WriteLine` call is a single `stdout.write` of the rendered string + `\n`. `Console.WriteStream` writes one chunk per iteration — chunk boundaries are upstream-defined.
- If a manifest needs literal `{` / `}` characters in console output, escape them with `\{` and `\}`.
