# @telorun/console

## 0.4.0

### Minor Changes

- f74bfa2: Three console-package changes bundled into one release.

  **New: `Console.StreamWait`** — stream passthrough that animates a single-cell frame sequence on stdout while waiting for the first item from the input stream, then clears the cell and forwards every item unchanged. Frames, prefix, and clear sequence are interleaved into the output stream — the controller never writes to stdout directly, so the downstream sink (typically `Console.WriteStream`) is the only stdout writer. Useful for "loading" indicators in CLI flows where the next step is a stream with measurable startup latency (HTTP requests, AI completions, file reads). Configurable `prefix`, `frames` (default braille spinner cycle), and `intervalMs` (default 80 ms; minimum 16). First frame paints synchronously to avoid an `intervalMs` blank gap.

  **New: console markup language** — every text path (`Console.WriteLine.output`, `Console.WriteStream` string chunks, `Console.ReadLine.prompt`, `Console.StreamWait.prefix`) interprets a small chalk-template-style markup at write time. Syntax: `{red text}`, `{red.bold ERROR}`, `{red.bgWhite warning}`, `{#ff8800 hex}`, `{red {bold WORLD}!}` (nested), `\{ \}` for literal braces. Renders to ANSI SGR codes when the underlying stdout is a TTY; strips to plain text otherwise. Detection is per-invocation via `ctx.stdout.isTTY`. Unknown styles fall back to literal text — no crash. **Migration note**: any existing manifest with literal `{…}` characters in console output now needs to escape them as `\{ \}` to preserve previous rendering. Unlikely in practice.

  **Behaviour change: `Console.ReadLine.prompt`** no longer auto-appends `": "` after the prompt text. The `prompt` field is now written to stdout character-for-character. Manifests that relied on `prompt: "Foo"` rendering as `Foo: ` must update to `prompt: "Foo: "`. In-tree consumers migrated: `examples/console-user-input.yaml` (Username/Password prompts) and `examples/chat-console.yaml` (ChatLoop reads).

## 0.3.0

### Minor Changes

- 795c117: Add `Console.WriteStream` — drains a `Stream<string | Uint8Array>` to stdout. Strings use Node's native UTF-8 path; `Uint8Array` chunks pass through unchanged. No newline policy. Pairs with text producers like `RecordStream.ExtractText` and byte-producing codecs (`Ndjson.Encoder`, `Sse.Encoder`, `Octet.Encoder`) on the same input contract.

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.1.11

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.1.10

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.1.9

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.1.8

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.7

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.6

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.5

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.1.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.1.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.4

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
