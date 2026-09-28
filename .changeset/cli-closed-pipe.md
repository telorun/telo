---
"@telorun/cli": patch
---

A command piped into a reader that closes early (`telo module versions … | head -2`) no longer crashes with an unhandled `EPIPE` stack trace: when stdout or stderr reports the reader gone, the CLI exits with the code the command already set, else 0. Any other stream error still surfaces. `telo run` is unchanged — its streams carry the application's output.
