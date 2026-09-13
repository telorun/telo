---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Module artifact selectors gain an `abi` axis, so a native file built for one runtime ABI can be declared on a bundled controller candidate (`&abi=node-137`), an `exports.code:` entry and a published layer selector, and is matched, keyed and described like `os`, `arch` and `libc`. Its value must be `<family>-<version>` (`node-137`, `telo-2`); a bare number is refused wherever a selector is read, with a message naming that form. The Node kernel reports `abi=node-<process.versions.modules>` and leaves it undetermined under Bun, so an abi-constrained layer never matches there. `telo install` gains `--abi <family>-<version>`; `--platform` parses as before, `abi` is never taken from the host, and without `--abi` no abi-constrained layer is warmed; install now reports every code layer it skips only because the target leaves an axis undetermined (an `abi`, or a `libc` that `--platform` omits). The axis names are now data (`analyzer/artifact-axes/axes.json`), generated into the analyzer at `prepare`; release ledger keys of layers without `abi` are unchanged.
