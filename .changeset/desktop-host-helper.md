---
"@telorun/cli": minor
---

Every release publishes `telo-desktop-host`, the webview helper `telo run` drives as the desktop host: native windows and tray icons over a framed link on its stdin and stdout. It is attached to the CLI's release as `telo-desktop-host-<version>-<os>-<arch>[-<libc>]` for linux, macOS and Windows on amd64 and arm64, each listed in `checksums.txt`.
