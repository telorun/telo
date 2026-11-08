# Desktop

Native windows and a tray icon for a web application. The module speaks one protocol (`kernel/specs/desktop-host.md`, generation `desktop_host-1`) to a **desktop host** — the process that owns the screen — and works against any host that supplies the `Telo.DesktopHost` need. The web application itself stays unchanged: a separate wrapper `Telo.Application` runs it and declares its windows.

## Why use this

- **Windows and tray icons are declared resources** — opened when the application runs, closed when it stops.
- **Menu items run actions** — any invocable of the application, with `inputs` checked against its contract by `telo check`.
- **Mistakes are caught before the app runs** — a `host` that is not a `Telo.DesktopHost` need, a `window` that is not a `Desktop.Window` and a tray icon that is not a PNG are refused statically.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Desktop.Window` | A native window on the application's local origin. |
| `Desktop.TrayIcon` | A notification-area / menu-bar icon with a tooltip and a menu of actions. |
| `Desktop.ShowWindow` | Invocable: shows and focuses a window. |
| `Desktop.Quit` | Invocable: asks the host for a graceful stop. |

## Hosts

`telo run` is not yet a desktop host. Today a host is supplied through the environment: set `TELO_NEED_<NEED>__ENDPOINT` (a `unix:` socket path, or `npipe:` on Windows) and `TELO_NEED_<NEED>__TOKEN` for the application's `Telo.DesktopHost` need, with a process speaking `desktop_host-1` behind the socket. Setting only one of the two is refused at load. The module's own tests do this with a fixture host.

Documentation: [windows](docs/windows.md), [tray icons](docs/tray-icons.md), [actions](docs/actions.md).
