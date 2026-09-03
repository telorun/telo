---
"@telorun/cli": patch
---

Remove the `--snapshot-on-exit` flag. It was accepted by the parser and read by nothing, so passing it changed no behaviour. It no longer appears in `--help`; `telo run` now forwards it to the application's own arguments like any other unrecognised flag, and the strict commands reject it.
