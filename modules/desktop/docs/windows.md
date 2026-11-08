# Windows

`Desktop.Window` is a `Telo.Service`. When the application runs it sends the host a `Window.Open`; when it stops it sends `Window.Close`. While a window is open it keeps the application alive.

```yaml
kind: Desktop.Window
metadata: { name: mainWindow }
host: !ref desktopHost
title: Hello
size: { width: 480, height: 320 }
minSize: { width: 320, height: 240 }
onClose: hide
```

| Field | Meaning |
| --- | --- |
| `host` | The application's `Telo.DesktopHost` need, as `!ref`. Anything else is `REFERENCE_KIND_MISMATCH`. |
| `path` | App-relative path the window opens at; default `/`. Every window opens on the need's one origin. |
| `title` | A `Text`, shown in the application's fallback language until the page sets its own document title. |
| `size`, `minSize` | `{ width, height }` in logical pixels. |
| `resizable` | Default `true`. |
| `visible` | Default `true`; `false` starts the window hidden. |
| `onClose` | `close` (default) destroys the window when the user closes it and stops holding the application for it; `hide` keeps it, and it is shown again by `Desktop.ShowWindow`. |

`Desktop.ShowWindow` takes a `window:` slot naming a `Desktop.Window` and shows and focuses it. If the host connection ends, the application is no longer held by its windows. After a `Desktop.Quit` that is the expected end and silent; a host that goes away on its own (a crash, a reset connection, a refused frame) is logged once at error severity with the code, the endpoint and the reason, and the application exits non-zero. A host that accepts the connection but does not answer the handshake within 5 seconds is `ERR_DESKTOP_HOST_UNREACHABLE`.

When the user closes a window declared `onClose: close` the host sends `Window.Closed`: the window stops holding the application, and a window or tray icon declared in a `Telo.Sequence`'s `with:` sends `Window.Close` / `Tray.Close` as the sequence ends.

Errors from the host reach the caller with the host's own code (`ERR_DESKTOP_HOST_UNKNOWN_ENTRY`, `ERR_DESKTOP_HOST_REQUEST_FAILED`); a wrong token, another protocol generation and an unreachable endpoint are `ERR_DESKTOP_HOST_TOKEN_INVALID`, `ERR_DESKTOP_HOST_INCOMPATIBLE` and `ERR_DESKTOP_HOST_UNREACHABLE` (see the diagnostics reference).
