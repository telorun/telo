---
"@telorun/console": minor
---

Three console-package changes bundled into one release.

**New: `Console.StreamWait`** — stream passthrough that animates a single-cell frame sequence on stdout while waiting for the first item from the input stream, then clears the cell and forwards every item unchanged. Frames, prefix, and clear sequence are interleaved into the output stream — the controller never writes to stdout directly, so the downstream sink (typically `Console.WriteStream`) is the only stdout writer. Useful for "loading" indicators in CLI flows where the next step is a stream with measurable startup latency (HTTP requests, AI completions, file reads). Configurable `prefix`, `frames` (default braille spinner cycle), and `intervalMs` (default 80 ms; minimum 16). First frame paints synchronously to avoid an `intervalMs` blank gap.

**New: console markup language** — every text path (`Console.WriteLine.output`, `Console.WriteStream` string chunks, `Console.ReadLine.prompt`, `Console.StreamWait.prefix`) interprets a small chalk-template-style markup at write time. Syntax: `{red text}`, `{red.bold ERROR}`, `{red.bgWhite warning}`, `{#ff8800 hex}`, `{red {bold WORLD}!}` (nested), `\{ \}` for literal braces. Renders to ANSI SGR codes when the underlying stdout is a TTY; strips to plain text otherwise. Detection is per-invocation via `ctx.stdout.isTTY`. Unknown styles fall back to literal text — no crash. **Migration note**: any existing manifest with literal `{…}` characters in console output now needs to escape them as `\{ \}` to preserve previous rendering. Unlikely in practice.

**Behaviour change: `Console.ReadLine.prompt`** no longer auto-appends `": "` after the prompt text. The `prompt` field is now written to stdout character-for-character. Manifests that relied on `prompt: "Foo"` rendering as `Foo: ` must update to `prompt: "Foo: "`. In-tree consumers migrated: `examples/console-user-input.yaml` (Username/Password prompts) and `examples/chat-console.yaml` (ChatLoop reads).
