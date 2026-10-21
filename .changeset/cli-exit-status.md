---
"@telorun/cli": minor
---

Every command line the CLI's argument parser refuses — an unknown flag, a missing argument or subcommand, a value outside an option's choices — now exits with status 2 instead of 1, with the usage and the reason on stderr and nothing on stdout. `-o yaml` is one of them: it used to end in a stack trace. The status contract is written in the README's "Exit status" section: 0 the command did its work, 1 the work failed, 2 the invocation was refused. `telo describe`, `telo needs report` and `telo env template` given a manifest that cannot be read now print one error line, as `telo check` does, rather than a stack trace.
