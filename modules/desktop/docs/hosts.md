# Hosts

The module speaks `desktop_host-1` (`kernel/specs/desktop-host.md`) to whatever supplies the application's `Telo.DesktopHost` need.

## `telo run` as the host

When the need's two variables (`TELO_NEED_<NEED>__ENDPOINT`, `__TOKEN`, or the names its `env:` binds) are both unset, `telo run` hosts the application itself, before anything initializes:

- It checks the machine (a display; macOS 14 or later) and starts the `telo-desktop-host` helper — the packaged one, a checkout's build, or the release's download. A failure is `ERR_DESKTOP_HOST_UNAVAILABLE`; `telo run --watch` does not host.
- It takes a lock per `identifier`, so the application runs once per user. A second start shows the running instance's windows, prints `<productName> is already running (process <pid>, <source>); its windows are shown` and exits 0.
- It binds `127.0.0.1` on a port it remembers across launches, so browser storage keyed by the origin survives restarts, and hands that port to the root's `ports:` entry the need names. A `default:` on that entry wins; when the remembered or declared port is taken, a new one is recorded and `DESKTOP_ORIGIN_CHANGED` names both origins.
- Only the application's own windows reach the port: a request without the cookie the host issues to its windows, or with another `Host` or `Origin`, is answered `403`. A window's first load is on a second loopback port of the host's own — the host origin, assigned at every launch — which sets that cookie and sends the window on to its page; cookies ignore the port, so the one cookie works on both. Every page the host itself shows (the startup view, the inputs form, the sign-in replay) is served there, and the application owns every path of its own origin.
- A window opens at once and shows a startup view; inputs the application asks for are asked in a form in that window, and a boot refusal is shown there.

A packaged app (`telo package`) is the same host, with its working directory and `TELO_HOST_STATE_DIR` under the per-user directory of its `identifier`.

## No tray

Where the session has no tray (stock GNOME without the AppIndicator extension), `Desktop.TrayIcon` logs `DESKTOP_TRAY_UNAVAILABLE`, shows nothing, and every `Desktop.Window` is shown at start, `visible: false` ones included. A second start then shows all of them.

## Another shell

A host that sets both variables carries the control channel only: `telo run` starts no helper, takes no lock, binds no port and admits nothing. Fronting the application's ports is that host's concern.
