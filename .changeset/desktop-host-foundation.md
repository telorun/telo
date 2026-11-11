---
"@telorun/cli": minor
"@telorun/kernel": minor
---

The pieces `telo run` acts as the desktop host with: the per-user application directory of a `Telo.DesktopHost`'s `identifier`, a single-instance lock per application, the window origin's remembered loopback port (`DESKTOP_ORIGIN_CHANGED` when it cannot be kept), the `telo-desktop-host` helper's location (the `TELO_HOST_DESKTOP_HELPER` path, the packaged copy, a cargo build in a source checkout, or the release download verified against `checksums.txt`), the availability checks behind `ERR_DESKTOP_HOST_UNAVAILABLE`, and the client of the helper's link. `TELO_HOST_DESKTOP_HELPER` is a host value: hidden from controllers and stripped from a started child application's environment.
