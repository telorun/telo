# Test font

`TestSans-Regular.ttf` is `KaTeX_SansSerif-Regular.ttf` from
[KaTeX](https://github.com/KaTeX/KaTeX), MIT licensed, renamed so nothing reads
it as an endorsement of a particular typeface.

It is here because exact measurement cannot be tested without a real face —
that is the whole difference between `exact: true` and the estimate. Chosen for
size: 19 KB, against 150 KB for a typical text face.

Fixtures never ship. A module's payload is what its `files:` allowlist and its
`controllers:` entry point name, and this module declares no `files:`.
