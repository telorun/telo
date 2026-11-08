---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

New kernel-declared need type `Telo.DesktopHost`, the desktop shell an application runs inside. Its fields are the shell's control channel, `endpoint` (a `unix:` or `npipe:` URL) and a sensitive `token`; its parameters are `identifier`, `productName`, an `icon` PNG written `!module-path`, `port` (a `tcp` key of `ports:`), `showInDock` and `callbackPaths`. It is `supply: root` and `unique: true`, read from `TELO_NEED_<NEED>__ENDPOINT` / `__TOKEN` like any root need, and listed by `telo needs report`. A `port` that is not a `tcp` key, a `callbackPaths` entry that is not a literal path starting with `/`, and parameters on a library's need are `NEED_PARAMETERS_INVALID`. `telo run` does not yet act as the host.
