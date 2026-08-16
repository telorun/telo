---
"@telorun/kernel": patch
"@telorun/cli": patch
---

The controller installer spawns its package manager through a shell on Windows.
There is no executable named `npm` there — npm, pnpm and every corepack shim are
`.cmd` files, which libuv's PATH search (`.com`/`.exe` only) never finds and
which Node has refused to spawn without a shell since CVE-2024-27980. Every
`pkg:npm` controller was therefore unloadable on Windows, and the failure was
reported as `'npm' not found on PATH … Install Node.js`, which told a user with
npm already installed to install the thing they had.

Going through `cmd.exe` moves the quoting obligation to the caller: Node builds
`cmd.exe /d /s /c "<file> <args joined by spaces>"` and quotes nothing, so the
installer quotes each argument itself. Both hazards are live in the arguments it
actually passes — a space in a `file:` install spec would re-split into two
arguments, and `^` in a semver range is cmd's escape character and is eaten
outside quotes. A literal `"` is rejected rather than escaped, since the escape
that restores cmd's quote state differs from the batch shim's own parser.

The COMMAND is quoted only when it cannot be left bare, because quoting a bare
one breaks the shim it resolves to. `npm.cmd` locates the CLI it exists to
launch as `%~dp0\node_modules\npm\bin\npm-cli.js`, and cmd substitutes the
resolved script path for `%0` only when the token was bare; quoted, `%~dp0`
expands against the current directory, so the shim looked for npm inside Telo's
own install root and failed with MODULE_NOT_FOUND on a path that never existed.
A command that does need quoting is a path rather than a name, and there `%0`
already carries a directory — so both cases are correct.

The not-found detection moved with it. Through a shell the binary always
resolves — `cmd.exe` exists — so a genuinely missing package manager arrives as
exit 9009 and "is not recognized as an internal or external command", matching
neither the `ENOENT` nor the wording the old check looked for; it would have
fallen through to the generic install-failure branch and buried the line naming
what to install.

The POSIX path is unchanged in both halves.
