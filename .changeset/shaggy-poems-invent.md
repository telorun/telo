---
"@telorun/analyzer": minor
"@telorun/cli": minor
---

Add declared runtime requirements: a module states, in a top-level `requires:` block,
the range of Telo it is verified against.

Telo closes every extension vocabulary and rejects an unknown token, which is right for
a typo and wrong for a version — so a module adopting new syntax broke on older runtimes
with a message blaming its own author. A declared range turns that into one accurate
diagnostic (`MODULE_REQUIRES_NEWER_RUNTIME`), and stops `telo upgrade` selecting versions
the running Telo cannot read at all.

`telo:` is a semver range over the manifest surface generation — one scale every kernel
reports, so there is no range per kernel — and host requirements nest under `host:`, where
`node` is the only axis for now, since an axis is added when something compares it and not
before. `^` and `~` are rejected: pre-1.0 they allow only one minor, and Telo
ships breaking changes as minor bumps, so they would pin a module to a single release
generation. An upper bound must name a version that already exists.

The claim is verified by running the CLI at each edge of the declared range, in
`telo publish`'s preflight and across the workspace in `telo release check`. A module
declaring nothing carries no requirement.
