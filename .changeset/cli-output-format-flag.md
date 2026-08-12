---
"@telorun/cli": minor
---

Global `-o, --output text|json` for the CLI's own output, and colour decided per stream.

Every command routes its output through one seam (`cli/nodejs/src/output.ts`) instead of writing `console.*` or `process.stdout.write` directly — enforced by a test, so the invariant is checkable rather than a convention.

**stdout is the machine surface; stderr stays human.** Under `-o json` stdout carries the payload and nothing else, so a caller reads `telo check`'s diagnostics by `code` and location instead of parsing prose. Prose keeps flowing to stderr in both formats — the convention npm, cargo and kubectl follow — because silencing it would swallow the reason a command failed, leaving `{"ok":false}` with no cause.

Two payload shapes share one serializer. `emit` writes a result envelope (`check`, `install`, `publish`, `upgrade`) and is silent under `text`. `document` writes a bare document (`cel`, `search`, `module versions|manifest|digest|resources|kinds`) in either format, since those commands' `--json` flags predate `-o` and keep working. A document command's stdout is the document or empty, never an error envelope — a CEL expression evaluating to `{"ok":false,…}` would otherwise be indistinguishable from a failure report — so its errors are prose on stderr plus a non-zero exit.

**`telo run` is exempt from `-o json`.** The kernel runs in-process and stdout/stderr are copied rather than redirected, so the app writes to those same descriptors and neither is the CLI's to claim; an envelope appended after app output would be unparseable. The machine surface for a run is `--debug`, whose wire protocol is framed per event precisely because it shares a stream.

Colour is decided separately for stdout and stderr rather than once from `process.stdout.isTTY`. Diagnostics go to stderr, so redirecting one stream and not the other previously emitted escapes where nothing could render them. stdout is never coloured under `-o json`, whatever `FORCE_COLOR` says.

A payload write is now followed by `process.exitCode` rather than `process.exit()`: on a pipe `write` is asynchronous and `exit` does not flush, so a large diagnostic set truncated into invalid JSON.

`yaml` is deliberately unimplemented — `-o` is an enum so it can gain that value without a second flag, and an unrecognized format throws instead of silently degrading to text.
