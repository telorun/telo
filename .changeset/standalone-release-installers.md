---
"@telorun/cli": patch
---

Every standalone target now builds, packages and installs. Four of the seven
produced no installer at all — macOS ships bsdtar, which has no `--transform`;
rpm stripped a payload built for another architecture; WiX v7 refuses to run
until its EULA is accepted; and a musl binary cannot execute on a glibc host.

Release assets carry the packaged formats only. The bare `telo` / `telo.exe`
collided across every target's job, so the file called `telo` on the release
page was whichever platform finished last. Their checksums are now one
`checksums.txt` covering every asset, in `sha256sum -c` format, rather than a
`.sha256` beside each file.

`install.sh` and `install.ps1` read that file, and they resolve the version
from the newest release tagged `v<version>` — `releases/latest` is the newest
release in the repository whatever it releases, so the version they installed
could come from an unrelated one. The Alpine case now says what it needs: the
musl build is linked against `libstdc++`, which a bare Alpine does not carry.

The advertised install command is `https://telo.sh/install.sh`
(`irm https://telo.sh/install.ps1 | iex` on Windows), which serves the scripts
that shipped with the release they install. `https://telo.run/install.sh` keeps
working.
