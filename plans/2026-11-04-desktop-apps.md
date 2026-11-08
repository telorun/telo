---
status: approved
priority: medium
depends-on: []
packages: [cli, kernel, cli/rust, modules/desktop, examples, docs, apps/authoring-agent, apps/hub]
---

# Desktop apps

## Problem

A Telo web app can only be shipped as a server. `telo package` writes one offline executable, but starting it opens no window. The user has to know a port and open a browser. The app listens on whatever `listen.address` says (`0.0.0.0` by default), so it can be reached from the LAN. Data lands in whatever directory the binary was started from.

The pieces a desktop app is built from exist:
- the `Telo.DesktopHost` need type: `supply: root`, `unique`; parameters `identifier`, `productName`, `icon` (a PNG `!module-path`), `port`, `showInDock`, `callbackPaths`; fields `endpoint` and sensitive `token`;
- `modules/desktop`: `Desktop.Window`, `Desktop.TrayIcon`, `Desktop.ShowWindow`, `Desktop.Quit`, speaking `desktop_host-1` (`kernel/specs/desktop-host.md`) over the controller protocol's frame;
- the kernel's host-supplied listener (`new Kernel({ listeners })`, `HostListeners.admit`, `Listener.Claim` / `Accept` / `Release`), which `Http.Server` serves;
- child applications: packaged with their parent, loaded from the payload, given `<state dir>/apps/<path>`, and never asking.

But nothing hosts them. A `Telo.DesktopHost` is answered only through its environment variables, so `telo run` of a wrapper app refuses it with `ERR_NEED_UNMET`, and `telo package` writes the same ELF for it as for a server.

## Solution

**The web app stays unchanged.** A separate **wrapper `Telo.Application`** runs it through `App.Instance`, declares a `Telo.DesktopHost` need and its windows. The same web app keeps deploying to a server through `telo run`, runners, Docker or a server binary.

**`telo run` is the desktop host** whenever the root declares a `Telo.DesktopHost` need and the environment sets neither of its fields. A packaged start is `telo run` of itself, so the packaged app behaves the same, by construction. A host supplied through the environment keeps working as today: `telo run` starts no helper, takes no lock, hands over no socket and admits nothing. Before anything initializes, the host:
- takes a single-instance lock per `identifier`: a local socket (a named pipe on Windows) in the per-user app directory (below), whose liveness is tested by connecting, so one a crashed instance left behind is replaced. A second start connects to it and asks for its windows: a second start, like a click on the macOS Dock icon, shows again every window the start showed — those declared `visible: true`, and the `visible: false` ones when no tray took their place (below) — focuses the first of them opened, prints one line naming the running instance's process and the manifest or packaged app it runs, and exits 0. A window the start did not show stays as it is.
- starts the `telo-desktop-host` helper and shows its startup view. Every window opens in a webview data store of the app's own — `<per-user app directory>/desktop-host/webview/` on Windows and Linux, a WebKit store whose identifier is a UUIDv5 of `identifier` on macOS — and never in a shared one, which is what keeps two Telo apps' cookies and browser storage apart.
- binds `127.0.0.1` for the need's `port` on a port that stays the same across launches, so the window's origin — and with it the web app's `localStorage`, IndexedDB and permission grants — does too. When the root's `ports:` entry declares a `default:`, the host binds that number, which is what lets an author register an exact redirect address with an identity provider. Otherwise it binds the port recorded in `<per-user app directory>/desktop-host/port`, OS-assigned and recorded on the first start. When the port it tries cannot be bound, or the file holds no port, a new OS-assigned one is recorded and the run logs a `DESKTOP_ORIGIN_CHANGED` warning naming both origins. The file is read and replaced only under the lock. The host then supplies that number to the root's port by name, hands the socket to the kernel as a host-supplied listener, and supplies the need: it serves `desktop_host-1` itself on a control channel of its own, with a fresh `token`.
- asks for the root's missing inputs in a form in the window. `--no-input` refuses instead, as today.
- shows a boot refusal in the window, with the diagnostics `telo run` prints, and exits 1. The listener's `503` body for an unclaimed connection is the window's startup view while starting, and the boot-refusal view once startup failed.

At run time:
- **Shutdown.** The app takes the same graceful stop as SIGTERM on `Host.Quit`, on OS quit and logoff, and when no window is visible while no tray icon is open. An app that ends on its own closes its windows and tray icons, and its exit status is the host's.
- **No tray on Linux.** Before boot the host checks the session bus for a StatusNotifierWatcher (stock GNOME has none). Without one it answers every `Tray.Open` with `available: false` — so each `Desktop.TrayIcon` logs `DESKTOP_TRAY_UNAVAILABLE`, shows no icon and does not count as open — and shows every window declared `visible: false`, so the app stays reachable.
- **Navigation.** A same-origin `window.open` opens another host window. Any other origin opens in the system browser.
- **External sign-in.** A sign-in that leaves for an external identity provider (OAuth, OIDC, SAML) returns through the loopback address, so the web app's own redirect address, built from its origin, works unchanged:
  - The host holds one armed return. Each navigation a window sends to the system browser arms it, recording that window; it is cleared when that window closes.
  - A request from the system browser to one of the need's `callbackPaths` is admitted without the cookie while a return is armed; `Host` is still checked. The first such request uses the return up.
  - The host does not serve that request to the browser. It answers it with its own page telling the user to return to the app (`productName`), focuses the window that armed the return, and replays the request there, where the cookie is:
    - a GET by navigating the window to the same path and query;
    - a form POST (`application/x-www-form-urlencoded`, at most 64 KiB) by navigating the window to the callback path with a single-use `_telo.return=<code>` parameter, which the host answers itself with a page on the app's origin that submits the form at once. The submission is same-origin, so it carries the cookie whatever the window showed before.
  - Any other return — unarmed, already used, to an undeclared path, or a POST of another type or size — gets `403`.
  - Protection against a forged return stays the web app's own `state` / PKCE check. A popup flow that relies on `window.opener` is not supported; the module docs say so.
  - A provider that accepts any loopback port (RFC 8252 §7.3) needs nothing more. One that matches the redirect address exactly needs the root's port to declare a `default:`; the module docs say so.
- **Unavailable.** With no display, no WebKitGTK (Linux), no WebView2 (Windows), macOS older than 14, or a helper that cannot be obtained, the start is refused with `ERR_DESKTOP_HOST_UNAVAILABLE`, naming the reason.

**Admission.** The host admits each connection on its first request, before handing it to the kernel (`HostListeners.admit`, with the bytes it read):
- `Host` must be `127.0.0.1:<port>`, and `Origin` must be absent or that origin.
- For each window it opens, the host gives the helper a single-use code over its link to the helper, and the helper navigates to the window's `path` with the query parameter `_telo.window=<code>`. The host answers that request itself: `303` to the same path and query without the parameter, with `Set-Cookie: telo-window=<token>; HttpOnly; SameSite=Strict; Path=/`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- Every other connection's first request must carry the `telo-window` cookie, whose value is the per-launch admission secret. It is the host's alone — distinct from the need's `token`, which secures the control channel — and never reaches the manifest's scope. Once admitted, a connection is handed over whole and its later requests reach the server unread.
- An armed return to a `callbackPaths` entry is the one request admitted without the cookie (External sign-in, above).
- A code that is unknown or already used, and anything else, gets `403` and the connection is closed.
- Neither secret appears in argv or a URL, and both join the root's redaction set.

**The helper** is a Rust wry/tao crate at `cli/rust/desktop-host`, carrying the CLI's version. It talks to `telo run` over the controller protocol's frame (the `@telorun/sdk` codec on the Node end), with a message set internal to one release:
- **Release.** Every release publishes it as `telo-desktop-host-<version>-<os>-<arch>[-<libc>]`, listed in `checksums.txt`.
- **`telo run` (standalone and npm CLI).** It downloads the helper on first use, checks it against the checksums and caches it under the user cache. The CLI does not carry it.
- **Source checkout.** The helper is built from the crate with cargo.

**Packaging** decides the output from a root `Telo.DesktopHost` need, reading the identity from the need table. The CLI never names a module kind. `telo package ./hello-desktop --out dist/Hello` writes:
- **darwin:** `dist/Hello.app`, with `Contents/Info.plist` from `identifier`, `productName`, `showInDock` and `metadata.version` and with `LSMinimumSystemVersion` 14.0, an `.icns` built from `icon`, the carrier at `Contents/MacOS/Hello` and the helper at `Contents/MacOS/telo-desktop-host`. Signing and notarizing are the operator's step.
- **windows:** `dist/Hello.exe`, a GUI-subsystem PE with icon and version resources and the payload carried as a PE resource. The helper rides in the payload.
- **linux:** the ELF as today, with the helper in the payload.

Packaging also:
- refuses an icon that is not square or is smaller than 1024 px with `ERR_DESKTOP_ICON_INVALID`, naming the file and its size;
- adds `desktopHost: { identifier }` to the payload index, which `telo package inspect` prints.

On a packaged desktop start:
- the working directory is the per-user app directory: `$XDG_DATA_HOME/<identifier>` (or `~/.local/share/<identifier>`), `~/Library/Application Support/<identifier>`, or `%LOCALAPPDATA%\<identifier>`. `.env` is read there.
- `TELO_HOST_STATE_DIR` is `<that>/state`.

`telo run` of a manifest keeps the working directory the developer started it in, but shares the per-user app directory's lock and `desktop-host/` with the packaged app of the same `identifier`. `desktop-host/` belongs to the desktop host, `state/` to the kernel. Under an environment-supplied host nothing is bound or recorded.

**Floors.** Every module and example this work touches gets its `requires.telo` from `telo release floor`, never by hand: syntax no published telo reads is measured as `>=unreleased`, which the release's version step turns into its version. A runtime need the measurement cannot see (a CLI host behaviour the manifest does not show) is a `restrictions:` entry with its reason.

**Hosts that cannot run a desktop app** stay as they are: a runner refuses with `ERR_NEED_UNMET`, `kernel/rust` and `cli/rust` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.

**Docs and bookkeeping:**
- `kernel/specs/desktop-host.md`: replace the placeholder section on admission and the helper with the admission code exchange and the single-instance protocol;
- amendments to `kernel/specs/packaged-application.md` (the desktop outputs, the per-user working directory);
- `modules/desktop` docs: replace "a host is supplied through the environment" with `telo run` as the host, and add external sign-in (popups unsupported, exact-redirect providers need a port `default:`);
- the packaging and providing-needs guides, including an external sign-in section in the providing-needs guide;
- a benefits-ledger entry, "Desktop apps", which names external sign-in;
- the authoring-agent primer and the hub `build_ui` guide;
- the root and CLI `CLAUDE.md` (`cli/rust/desktop-host` is a second crate with no Node twin, beside `telorun-abi`);
- `examples/hello-web` and `examples/hello-desktop`, with tests beside each.

## Decisions

- **Wrapper application, not a key on the web app.** The web app must deploy unchanged. A top-level `desktop:` block on every Application, or a new root kind, was rejected: one breaks the one-root-doc rule and the other adds an Application key for one feature.
- **Identity on a built-in need.** Packaging reads it the way the kernel reads `Telo.DurableDirectory` and `Telo.PublicUrl`, never a module's kind. A flag on `telo package` was rejected: the analyzer and the editor cannot check it.
- **The port lives on the need, not on the window.** The host binds before boot and cannot read `Desktop.Window`. One origin per app also keeps admission to one cookie.
- **Socket handover and admission stay with `telo run`'s own host.** An environment-supplied host gets the control channel only; fronting the ports is its concern.
- **Admission rides a one-time code in the first URL, not a request header.** A URL is the one carrier every webview is sure to send; the code is single-use and is not the token, so history and `Referer` leak nothing.
- **Other origins open in the system browser, and sign-in returns through loopback.** An embedded sign-in page is what RFC 8252 forbids and Google refuses. A loopback return keeps the web app's own redirect address, works under `telo run` on every platform and carries a form POST. Replaying it into the window keeps the session in the window's cookies rather than the browser's. A private-use URL scheme is not part of this plan: it needs the web app reconfigured and per-platform registration, and macOS registers one only for an app bundle.
- **No tray on Linux warns and shows the hidden windows.** Refusing would make an app unusable on stock GNOME for want of an optional icon.
- **An icon's size is a packaging refusal.** Only the packager needs a 1024 px square, and a static size check would need a dimension reader per media type.
- **The desktop host lives in the CLI, not the module.** Startup view, input form, boot errors and single instance happen before any resource exists.
- **Socket handover on a remembered port.** Only a socket the host owns confines the server to loopback, puts admission in front of it and closes the pick-to-bind race, with the web app unchanged. Keeping the port keeps the origin, which browser storage is keyed by; a custom-scheme origin would break WebSocket and cookies on WKWebView. The port is remembered rather than declared because a declared one collides between users of one machine, so a declared `default:` is used only by apps that need an exact redirect address, and a collision still falls back.
- **Apps are isolated by their webview store, not by the cookie's name.** Cookies are sent by host, not port, so in a shared store a port-named cookie would still reach the other app's server. macOS has a per-app store only from 14, hence the floor.
- **The helper is downloaded, not embedded,** to keep the CLI small. A packaged app embeds it, so it still runs offline.

## Verify

1. `examples/hello-web/telo.yaml` is byte-identical in both builds, and its server binary binds `0.0.0.0:$PORT`.
2. `telo run ./examples/hello-desktop` opens a window showing the page and a tray icon. Closing the window hides it and the app keeps running. The tray's "Open Hello" and a second run both show it again, the second run exiting 0. "Settings", declared `visible: false`, opens only from the tray, and a second run leaves it hidden even after it was opened from the tray and hidden again. "Quit" logs the same unwind as SIGTERM and exits 0.
3. "Write status to log" writes its line through `Console.writeLine`. On GNOME without the AppIndicator extension the run logs `DESKTOP_TRAY_UNAVAILABLE`, "Settings" is shown at start, a second run shows both windows, and closing both stops the app. On macOS, `showInDock: false` leaves no Dock icon under `telo run` and writes `LSUIElement` into the packaged `Info.plist`.
4. `curl` to the port gets 403 without the cookie, with a forged `Host`, with a replayed `_telo.window` URL, and from another OS user. The page's `location` never shows `_telo.window`. Pages, EventSource and WebSocket work in the window. Two desktop apps run side by side under `telo run`, each keeping its own admission, and neither server receives the other's cookie. A value a page writes to `localStorage` is there after quit and restart, on the same port. With that port occupied, the next start logs `DESKTOP_ORIGIN_CHANGED` and records the new port. On macOS 13 `telo run` is refused with `ERR_DESKTOP_HOST_UNAVAILABLE` and the packaged app is refused by macOS. `Kernel.PortsResolved` shows `address: 127.0.0.1, suppliedBy: host`.
5. The same web-app variable declared on the wrapper and passed through is asked for in the window, and refused under `--no-input`. A boot refusal is shown in the window.
6. `telo package ./examples/hello-desktop` writes `Hello.app` on macOS, a GUI `Hello.exe` with no console on Windows, and the ELF on Linux. Each starts offline, and a `Telo.DurableDirectory` need `data` of the web app lands at `<data dir>/state/apps/web/needs/data`. It carries `icon.png` and `tray.png` with no `files:` entry, and an icon under 1024 px is refused with `ERR_DESKTOP_ICON_INVALID`.
7. A signed `Hello.exe` (signtool) still finds its payload.
8. A fixture identity provider with a GET callback, and one answering with `form_post`, signs the window in under `telo run` and in the packaged app, also when the window showed an error page before the return; the system browser shows the return page, and the window ends signed in. A fixture matching the redirect address exactly works when the root's port declares a `default:`. A replayed, unarmed or undeclared return gets 403, as does a second return after one external navigation.
9. A window opened before the web app's server is up shows the page once it is; with the server never starting, the window shows the boot-refusal view and a request gets `503`. A second start prints the running instance's process and source.
10. With the env supply (`TELO_NEED_DESKTOP_HOST__ENDPOINT` / `__TOKEN` set), `telo run` starts no helper and binds nothing.

## Examples

### The manifests

`examples/hello-web/telo.yaml`, the unchanged web app:

```yaml
kind: Telo.Application
metadata: { name: HelloWeb, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.42.0#sha256-wF3AHGL8hGFdy7SfxXJkaXtRzLeqKtgqTVmN9anXKTk
  Run: oci://ghcr.io/telorun/run@0.32.0#sha256-4BOwkyKZuEAr-gDIkQWEzA1UszTNrIGHyv9GFnnUkv8
ports:
  http: { env: PORT, default: 8080 }
targets:
  - !ref helloServer
---
kind: Http.Server
metadata: { name: helloServer }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /, mount: !ref helloPage }
---
kind: Http.Api
metadata: { name: helloPage }
routes:
  - request: { path: /, method: GET }
    handler: { kind: Run.Value, value: {} }
    returns:
      - { status: 200, content: { text/html: { body: "<h1>Hello, world!</h1>" } } }
  - request: { path: /settings, method: GET }
    handler: { kind: Run.Value, value: {} }
    returns:
      - { status: 200, content: { text/html: { body: "<h1>Settings</h1>" } } }
```

`examples/hello-desktop/telo.yaml`, the desktop app, with `icon.png` (1024 × 1024) and `tray.png` beside it. Its imports are pinned at the versions published when it is written, and its floor is what `telo release floor` measures:

```yaml
kind: Telo.Application
metadata: { name: HelloDesktop, version: 1.0.0 }
lang: en
requires: { telo: ">=unreleased" }
imports:
  App: oci://ghcr.io/telorun/app@0.5.1#sha256-A_gkbdHIqYdg93KYHDkjWl7zGnnYBN8dC7TEzMBMUmk
  Console: oci://ghcr.io/telorun/console@0.19.1#sha256-OxO1ccClyEMMTXmfpkw8kWwjaEEPOZzPgmUXO1ZqWnE
  Desktop: oci://ghcr.io/telorun/desktop@0.1.0
ports:
  http: { env: PORT }
needs:
  desktopHost:
    kind: Telo.DesktopHost
    parameters:
      identifier: run.telo.examples.hello
      productName: Hello
      icon: !module-path icon.png
      port: http
      showInDock: false
targets:
  - !ref web
  - !ref mainWindow
  - !ref settingsWindow
  - !ref tray
---
kind: App.Instance
metadata: { name: web }
source: ../hello-web
ports: { http: !cel "ports.http" }
---
kind: Desktop.Window
metadata: { name: mainWindow }
host: !ref desktopHost
title: Hello
size: { width: 480, height: 320 }
minSize: { width: 320, height: 240 }
onClose: hide
---
kind: Desktop.Window
metadata: { name: settingsWindow }
host: !ref desktopHost
path: /settings
title: { text: Settings, context: window title }
size: { width: 400, height: 300 }
resizable: false
visible: false
onClose: hide
---
kind: Desktop.TrayIcon
metadata: { name: tray }
host: !ref desktopHost
icon: !module-path tray.png
monochrome: true
tooltip: Hello
action: { invoke: { kind: Desktop.ShowWindow, window: !ref mainWindow } }
menu:
  - { type: item, label: Open Hello, action: { invoke: { kind: Desktop.ShowWindow, window: !ref mainWindow } } }
  - { type: item, label: Settings, action: { invoke: { kind: Desktop.ShowWindow, window: !ref settingsWindow } } }
  - type: item
    label: Write status to log
    action:
      invoke: !ref Console.writeLine
      inputs: { output: Hello is running }
  - { type: item, label: Hello 1.0, enabled: false }
  - { type: separator }
  - { type: item, label: Quit, action: { invoke: { kind: Desktop.Quit, host: !ref desktopHost } } }
```

`mainWindow` and `settingsWindow` stay named because two actions and `targets:` reach each. Under `telo run`, `PORT` needs no value: the desktop host supplies the port.

### Command line

```
$ telo run ./examples/hello-desktop
$ telo run ./examples/hello-desktop     # while the first still runs
Hello is already running (process 48213, /home/me/telo/examples/hello-desktop/telo.yaml); its windows are shown
$ echo $?
0
```

The desktop wrapper's payload index names its identity:

```
$ telo package ./examples/hello-desktop --out dist/Hello
$ TELO_APP_CLI=1 dist/Hello package inspect dist/Hello
{
  "format": 1,
  "app": { "name": "HelloDesktop", "version": "1.0.0" },
  "entry": "app/telo.yaml",
  "platform": { "os": "linux", "arch": "amd64", "libc": "gnu", "abi": "node-127" },
  "telo": "0.133.0",
  "analysisKey": "sha256:5f0c6b1e9d2a47c3b8e1f4a6d7c9b2e0a3f5d8c1b4e7a9f2c6d3b8e5a1f4c7d0",
  "desktopHost": { "identifier": "run.telo.examples.hello" },
  "modules": [
    { "source": "oci://ghcr.io/telorun/app@0.5.1", "name": "App", "version": "0.5.1", "delivery": "artifact" },
    { "source": "oci://ghcr.io/telorun/console@0.19.1", "name": "Console", "version": "0.19.1", "delivery": "artifact" },
    { "source": "oci://ghcr.io/telorun/desktop@0.1.0", "name": "Desktop", "version": "0.1.0", "delivery": "artifact" },
    { "source": "../hello-web", "name": "HelloWeb", "version": "1.0.0", "delivery": "local" },
    { "source": "oci://ghcr.io/telorun/http-server@0.42.0", "name": "Http", "version": "0.42.0", "delivery": "artifact" },
    { "source": "oci://ghcr.io/telorun/run@0.32.0", "name": "Run", "version": "0.32.0", "delivery": "artifact" }
  ],
  "payload": { "bytes": 52430848, "digest": "sha256:3c7e1a9f5d2b8e4c6a0f2b4d6e8a1c3f5b7d9e2a4c6f8b0d1e3a5c7f9b2d4e6a8", "placement": "trailer" }
}
```

A packaging refusal:

```
$ telo package ./examples/hello-desktop --out dist/Hello
[ERR_DESKTOP_ICON_INVALID] icon.png must be square and at least 1024 px (it is 512 × 512)
$ echo $?
1
```

The helper's release assets, for release `0.133.0`:

```
telo-desktop-host-0.133.0-linux-amd64-gnu
telo-desktop-host-0.133.0-linux-arm64-gnu
telo-desktop-host-0.133.0-darwin-amd64
telo-desktop-host-0.133.0-darwin-arm64
telo-desktop-host-0.133.0-windows-amd64.exe
telo-desktop-host-0.133.0-windows-arm64.exe
```

### Hosts that refuse

On macOS 13:

```
$ telo run ./examples/hello-desktop
[ERR_DESKTOP_HOST_UNAVAILABLE] cannot start the desktop host: macOS 14 or later is required (this is macOS 13.6)
```

With the helper not in the cache and its download failing:

```
$ telo run ./examples/hello-desktop
[ERR_DESKTOP_HOST_UNAVAILABLE] cannot start the desktop host: telo-desktop-host-0.133.0-linux-amd64-gnu could not be downloaded (HTTP 503 from github.com)
```

On a Linux machine with no display:

```
$ telo run ./examples/hello-desktop
[ERR_DESKTOP_HOST_UNAVAILABLE] cannot start the desktop host: no display (neither WAYLAND_DISPLAY nor DISPLAY is set)
$ echo $?
1
```

On GNOME without the AppIndicator extension, the run logs:

```
WARN  DESKTOP_TRAY_UNAVAILABLE  Desktop.TrayIcon/tray: this session has no StatusNotifierWatcher, so tray icons need the AppIndicator extension; showing settingsWindow instead
```

### State on disk

The packaged `Hello` on Linux, after a first start, when `hello-web` also declares a `Telo.DurableDirectory` need `data`:

```
$ tree -a -L 4 ~/.local/share/run.telo.examples.hello
/home/me/.local/share/run.telo.examples.hello
├── .env
├── desktop-host
│   ├── port
│   └── webview
└── state
    └── apps
        └── web
            └── needs
$ cat ~/.local/share/run.telo.examples.hello/desktop-host/port
53817
```

`state/apps/web/needs/` holds `data`. With port 53817 taken by another program, the next start logs:

```
WARN  DESKTOP_ORIGIN_CHANGED  /home/me/.local/share/run.telo.examples.hello/desktop-host/port named 53817, which is in use; the window's origin is now http://127.0.0.1:41022 instead of http://127.0.0.1:53817, so what the page kept in browser storage starts empty
```

### External sign-in

`examples/notes-desktop/telo.yaml` wraps `notes-web`, a web app that signs users in through an OIDC provider and receives the answer at `/auth/callback`, with `icon.png` beside it:

```yaml
kind: Telo.Application
metadata: { name: NotesDesktop, version: 1.0.0 }
lang: en
requires: { telo: ">=unreleased" }
imports:
  App: oci://ghcr.io/telorun/app@0.5.1#sha256-A_gkbdHIqYdg93KYHDkjWl7zGnnYBN8dC7TEzMBMUmk
  Desktop: oci://ghcr.io/telorun/desktop@0.1.0
ports:
  http: { env: PORT, default: 53817 }
needs:
  desktopHost:
    kind: Telo.DesktopHost
    parameters:
      identifier: run.telo.examples.notes
      productName: Notes
      icon: !module-path icon.png
      port: http
      callbackPaths: [/auth/callback]
targets:
  - !ref web
  - !ref mainWindow
---
kind: App.Instance
metadata: { name: web }
source: ../notes-web
ports: { http: !cel "ports.http" }
---
kind: Desktop.Window
metadata: { name: mainWindow }
host: !ref desktopHost
title: Notes
size: { width: 960, height: 640 }
```

`mainWindow` stays named because `targets:` reaches it and the host addresses it by name. The port's `default:` lets the author register `http://127.0.0.1:53817/auth/callback` with a provider that matches it exactly. The user clicks "Sign in"; the window's navigation to `https://id.example.com/authorize?…&redirect_uri=http%3A%2F%2F127.0.0.1%3A53817%2Fauth%2Fcallback` opens in the system browser and arms a return. After the user signs in, the provider sends the browser back:

```
GET /auth/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj HTTP/1.1
Host: 127.0.0.1:53817

HTTP/1.1 200 OK
Content-Type: text/html
Cache-Control: no-store

<p>Return to Notes to finish signing in.</p>
```

The host focuses `mainWindow` and replays the request there, where it reaches `notes-web` with the window's cookie:

```
GET /auth/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj HTTP/1.1
Host: 127.0.0.1:53817
Cookie: telo-window=8d2f6a1c9e4b7d3f0a5c2e8b1d6f4a9c

HTTP/1.1 302 Found
Location: /
Set-Cookie: notes-session=Jk29fQ7xLm; HttpOnly; SameSite=Lax; Path=/
```

A provider answering with `form_post` returns a POST instead. The browser gets the same return page:

```
POST /auth/callback HTTP/1.1
Host: 127.0.0.1:53817
Content-Type: application/x-www-form-urlencoded
Content-Length: 46

code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj

HTTP/1.1 200 OK
Content-Type: text/html
Cache-Control: no-store

<p>Return to Notes to finish signing in.</p>
```

The host navigates `mainWindow` to a single-use page of its own on the app's origin, which submits the form at once:

```
GET /auth/callback?_telo.return=Hq3ZpW8sNc2v HTTP/1.1
Host: 127.0.0.1:53817
Cookie: telo-window=8d2f6a1c9e4b7d3f0a5c2e8b1d6f4a9c

HTTP/1.1 200 OK
Content-Type: text/html
Cache-Control: no-store

<form method="post" action="/auth/callback"><input type="hidden" name="code" value="SplxlOBeZQQYbYS6WxSbIA"><input type="hidden" name="state" value="af0ifjsldkj"></form><script>document.forms[0].submit()</script>
```

The submission reaches `notes-web` with the window's cookie:

```
POST /auth/callback HTTP/1.1
Host: 127.0.0.1:53817
Cookie: telo-window=8d2f6a1c9e4b7d3f0a5c2e8b1d6f4a9c
Origin: http://127.0.0.1:53817
Content-Type: application/x-www-form-urlencoded
Content-Length: 46

code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj

HTTP/1.1 302 Found
Location: /
Set-Cookie: notes-session=Jk29fQ7xLm; HttpOnly; SameSite=Lax; Path=/
```

The same return a second time, with no navigation armed, and a return to a path `callbackPaths` does not list:

```
GET /auth/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj HTTP/1.1
Host: 127.0.0.1:53817

HTTP/1.1 403 Forbidden
Connection: close

GET /oauth2/return?code=SplxlOBeZQQYbYS6WxSbIA HTTP/1.1
Host: 127.0.0.1:53817

HTTP/1.1 403 Forbidden
Connection: close
```

### Admission on the wire

The window's first navigation, with the code the host gave the helper:

```
GET /?_telo.window=Q7vK2mX9pL4s HTTP/1.1
Host: 127.0.0.1:53817

HTTP/1.1 303 See Other
Location: /
Set-Cookie: telo-window=8d2f6a1c9e4b7d3f0a5c2e8b1d6f4a9c; HttpOnly; SameSite=Strict; Path=/
Referrer-Policy: no-referrer
Cache-Control: no-store
```

The follow-up reaches the web app:

```
GET / HTTP/1.1
Host: 127.0.0.1:53817
Cookie: telo-window=8d2f6a1c9e4b7d3f0a5c2e8b1d6f4a9c

HTTP/1.1 200 OK
Content-Type: text/html

<h1>Hello, world!</h1>
```

A replayed code, a missing cookie or a forged `Host`:

```
GET /?_telo.window=Q7vK2mX9pL4s HTTP/1.1
Host: 127.0.0.1:53817

HTTP/1.1 403 Forbidden
Connection: close
```

The port's entry on `Kernel.PortsResolved`:

```json
{ "ports": [{ "port": 53817, "protocol": "tcp", "address": "127.0.0.1", "suppliedBy": "host" }] }
```
