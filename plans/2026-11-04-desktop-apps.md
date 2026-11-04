---
status: approved
priority: medium
depends-on: []
packages: [sdk, analyzer, kernel, cli, kernel/rust, cli/rust, sdk/rust, modules/desktop, modules/app, modules/http-server, docs, apps/authoring-agent]
---

# Desktop apps

## Problem

A Telo web app can only be shipped as a server. `telo package` writes one offline executable, but starting it opens no window. The user has to know a port and open a browser. The app listens on whatever `listen.address` says (`0.0.0.0` by default), so it can be reached from the LAN. Data lands in whatever directory the binary was started from.

Supervising another app does not help today:
- `telo package` carries only the `imports:` closure, so an app started by `App.Instance` with a relative `source:` is missing from the payload. At run time the child does not exist, and its imports would need the network.
- A child started by `App.Instance` loses `TELO_HOST_STATE_DIR`, so its durable directories are not answered.
- A child cannot ask for a missing input. It is refused instead.

## Solution

**The web app stays unchanged.** A separate **wrapper `Telo.Application`** runs it through `App.Instance` and declares its windows. The same web app keeps deploying to a server through `telo run`, runners, Docker or a server binary.

**`Telo.DesktopHost`** is a new kernel-declared need type with `supply: root` and `unique: true`:
- Parameters:
  - `identifier`: reverse-DNS.
  - `name`: a plain string, the product name.
  - `icon`: a `Telo.HostPath` with `entry: file`, written `!module-path`.
  - `port`: a `tcp` key of the root's `ports:`.
  - `dock`: a boolean, default `true`. `false` gives a macOS app no Dock icon and no app menu (`LSUIElement`), for an app that lives in the menu bar. Other platforms ignore it.
- Fields: `endpoint`, a `Telo.Url` with scheme `unix` or `npipe`, and `token`, which is `x-telo-sensitive`. They are the desktop host's control channel.
- It is supplied like every root need. Its fields are read from the environment (`TELO_NEED_<NEED>__ENDPOINT` / `TELO_NEED_<NEED>__TOKEN`, or the names its `env:` binds), and when neither is set, `telo run` supplies it as the desktop host (below). One set and not the other is `ERR_NEED_PARTIALLY_SUPPLIED`.
- `telo needs report` lists it with its parameters and both variables.

**Two generic need-type additions** come with it:
- **`unique: true`** on a `Telo.NeedType`: a module declares at most one need of the type. A second one is `NEED_DUPLICATE` / `ERR_NEED_DUPLICATE`, naming both needs.
- **`!module-path` in need parameters.** A parameter whose schema is a `Telo.HostPath` accepts a `!module-path`, resolved against the declaring module at load. It is a module file claim like any other: `telo publish` / `telo package` carry the file, a missing file is `MODULE_PATH_NOT_FOUND`, and a directory where `entry: file` is declared is `HOST_PATH_ENTRY_MISMATCH`. Any other tag in `parameters:` stays `NEED_PARAMETERS_INVALID`.

**`Desktop.Window`** comes from a new stdlib module, `modules/desktop`. It is a `Telo.Service` with:
- `host`: a reference slot of type `Telo.DesktopHost`;
- `path` (default `/`);
- `title` (a `Text`; the page's document title replaces it once loaded);
- `size`, `minSize`, `resizable`;
- `visible` (default `true`): `false` starts the window hidden;
- `onClose`: `close` (default) or `hide`. A hidden window keeps running and is shown again by a tray `open:` action, a second launch or a click on the macOS Dock icon.

`run()` opens the window and its inverse closes it. Every window opens on the need's one origin.

**`Desktop.Tray`**, in the same module, is a `Telo.Service` for an icon in the Windows notification area, the macOS menu bar or a Linux AppIndicator. It has:
- `host`: a reference slot of type `Telo.DesktopHost`;
- `icon`: a PNG written `!module-path`, scaled by the host. `template: true` draws it as a macOS template image that follows the menu bar's light or dark appearance. A file that is not a PNG is refused when the tray opens with `ERR_DESKTOP_TRAY_ICON_INVALID`, naming the file;
- `tooltip`: a `Text`;
- `action`: what a primary click on the icon does on Windows. On macOS and Linux a click always opens the menu;
- `menu`: a list of items and `separator: {}` entries. An item has a literal `label` (a `Text`), an `action`, and `visible`, `enabled` and `checked`, each a boolean or a `!cel` boolean over `resources.*`.

An action is one of:
- `open: !ref <window>`: show and focus a `Desktop.Window`;
- `quit: {}`: the same graceful stop as SIGTERM;
- `invoke: !ref <invocable>`, with optional `inputs`: an inbound trigger (`use: trigger.inbound`) dispatching the invocable in the wrapper app. A failure is logged and the menu stays usable.

A menu's `visible`, `enabled` and `checked` are evaluated when the tray opens and again whenever a resource they read republishes (after its `run()`, an `invoke()` or a `setStatus()`). A label that changes with state ("Pause" / "Resume") is two items with opposite `visible`, so every label stays a literal, translatable `Text`. The tray messages are part of `desktop-host-1`. The module talks only the desktop-host protocol (`kernel/specs/desktop-host.md`, generation `desktop-host-1`). Its first exchange on the control channel names the generation each side speaks. A host that speaks another one is refused with `ERR_DESKTOP_HOST_PROTOCOL`, naming both generations.

A host family is a pair: one kernel-declared need type and one stdlib module, each with its own protocol and generation. Mobile is a separate family (`Telo.MobileHost`, `modules/mobile`, `mobile-host-1`) with its own plan, so the desktop and mobile surfaces evolve independently. Only the generic kernel mechanisms below (port handover, admission, child applications) are shared.

**`telo run` is the desktop host** whenever the root declares a `Telo.DesktopHost` need and the environment sets neither of its fields. A packaged start is `telo run` of itself, so the packaged app behaves the same, by construction. Before anything initializes, the host:
- takes a single-instance lock per `identifier`. A second start shows and focuses the running instance's windows, hidden ones included, and exits 0.
- starts the `telo-desktop-host` helper and shows its startup view.
- binds `127.0.0.1` on an OS-assigned port for the need's `port`, supplies that number to the root's port by name, and supplies the need.
- asks for missing inputs, including a child's, in a form in the window. `--no-input` refuses instead, as today.
- shows a boot refusal in the window, with the diagnostics `telo run` prints, and exits 1.

At run time:
- **Shutdown.** The app takes the same graceful stop as SIGTERM on a `quit` action, on OS quit and logoff, and when no window is visible while no tray is open. An app that ends on its own closes its windows and trays, and its exit status is the host's.
- **No tray on Linux.** Before boot the host checks the session bus for a StatusNotifierWatcher (stock GNOME has none). Without one, each `Desktop.Tray` logs a `DESKTOP_TRAY_UNAVAILABLE` warning saying AppIndicator support is missing, shows no icon and does not count as open, and every window declared `visible: false` is shown, so the app stays reachable.
- **Navigation.** A same-origin `window.open` opens another host window. Any other origin opens in the system browser.
- **Unavailable.** With no display, no WebKitGTK (Linux) or no WebView2 (Windows), or a helper that cannot be obtained, the start is refused with `ERR_DESKTOP_HOST_UNAVAILABLE`, naming the reason.

**A host supplied through the environment** — another shell embedding Telo, or a test fixture speaking `desktop-host-1` — gets the control channel only. `telo run` starts no helper, takes no lock, hands over no socket and admits nothing. The app's ports bind as they do without the need, and fronting them is that host's concern.

**Port handover and admission.** The kernel gains a generic **host-supplied listener**:
- A server configured with a port number the host holds a socket for serves that socket and binds nothing itself. The socket follows the number into an `App.Instance` child.
- `Kernel.PortsResolved` entries gain `address` and `suppliedBy: host`.
- A host socket no server claimed by the end of startup is a warning naming the port key.

It is a new controller-protocol message (generation `telo-10`), adopted by `http-server`. The host admits each connection on its first request, before handing the connection on:
- `Host` must be `127.0.0.1:<port>`, and `Origin` must be absent or that origin.
- The request must carry the per-launch token, as the `Telo-Window-Token` header on the window's first navigation or the `telo-window` cookie after it.
- A request bearing the header is answered by the host itself: `303` to the same path, with `Set-Cookie: telo-window=<token>; HttpOnly; SameSite=Strict; Path=/`.
- Anything else gets `403` and the connection is closed.
- The token never appears in argv or a URL, and it joins the root's redaction set.

**The helper** is a Rust wry/tao crate at `cli/desktop-host/`:
- **Release.** Every release publishes it as `telo-desktop-host-<version>-<os>-<arch>[-<libc>]`, listed in `checksums.txt`.
- **`telo run` (standalone and npm CLI).** It downloads the helper on first use, checks it against the checksums and caches it under the user cache. The CLI does not carry it.
- **Source checkout.** The helper is built from the crate with cargo.

**Packaging** decides the output from a root `Telo.DesktopHost` need, reading the identity from the need table. The CLI never names a module kind. `telo package ./hello-desktop --out dist/Hello` writes:
- **darwin:** `dist/Hello.app`, with `Contents/Info.plist` from `identifier`, `name` and `metadata.version`, an `.icns` built from `icon`, the carrier at `Contents/MacOS/Hello` and the helper at `Contents/MacOS/telo-desktop-host`. Signing and notarizing are the operator's step.
- **windows:** `dist/Hello.exe`, a GUI-subsystem PE with icon and version resources and the payload carried as a PE resource. The helper rides in the payload.
- **linux:** the ELF as today, with the helper in the payload.

Packaging also:
- refuses an icon that is not a square PNG of at least 1024 px, naming the file;
- adds `desktopHost: { identifier }` to the payload index, which `telo package inspect` prints.

On a packaged desktop start:
- the working directory is the per-user app directory: `$XDG_DATA_HOME/<identifier>` (or `~/.local/share/<identifier>`), `~/Library/Application Support/<identifier>`, or `%LOCALAPPDATA%\<identifier>`. `.env` is read there.
- `TELO_HOST_STATE_DIR` is `<that>/state`.

`telo run` of a manifest keeps the working directory the developer started it in.

**Child applications** (generic, every supervisor app benefits):
- `telo package` follows every `x-telo-application-source` edge. The child's manifest, files, import closure, built local modules and the portability check go into the payload, and a child's relative `source:` resolves inside the unpacked tree.
- A child loads against the payload's sealed cache.
- A child under a parent with `TELO_HOST_STATE_DIR` gets `<state dir>/apps/<instance name>`. The orphan rule covers `apps/` as it covers `needs/`.
- A child asks for missing inputs through the parent's input resolver, and each question names the instance.

**Static checks:**
- A `Telo.DesktopHost` declared with parameters on a Library, or a `port` that is not a `tcp` key of `ports:`, is `NEED_PARAMETERS_INVALID`, as for `Telo.PublicUrl`.
- A module with two needs of a `unique` type is `NEED_DUPLICATE` / `ERR_NEED_DUPLICATE`, with both rows in `tests/check-run-agreement.yaml`.
- A `!module-path` parameter naming nothing is `MODULE_PATH_NOT_FOUND`, one naming a directory `HOST_PATH_ENTRY_MISMATCH`, and any other tag in `parameters:` `NEED_PARAMETERS_INVALID`, each with both rows in `tests/check-run-agreement.yaml`.
- `Desktop.Window.host` or `Desktop.Tray.host` naming anything else, or an `open:` naming anything but a `Desktop.Window`, is `REFERENCE_KIND_MISMATCH`.
- A menu's `visible`, `enabled` and `checked` are type-checked as booleans; anything else is `CEL_TYPE_ERROR`.

**Hosts that cannot run a desktop app:**
- A runner never supplies `Telo.DesktopHost`, so it refuses with `ERR_NEED_UNMET`, naming both variables as for any need.
- `kernel/rust` and `cli/rust` refuse it with `ERR_UNSUPPORTED_MANIFEST_FEATURE`. This is polyglot debt, as is the `telo-10` message in `sdk/rust` / `kernel/rust`.

**Docs and bookkeeping:**
- `kernel/specs/desktop-host.md` (new);
- amendments to `kernel/specs/packaged-application.md`;
- `modules/desktop` docs (windows and trays), `README.md`, `LICENSE` and `license: MIT`, with a `requires: telo:` floor;
- `app` module docs (the child state directory and asking);
- the packaging and providing-needs guides, and the need-types guide (`unique`, `!module-path` parameters);
- a benefits-ledger entry, "Desktop apps";
- the authoring-agent primer and the hub `build_ui` guide;
- the root and CLI `CLAUDE.md`;
- `examples/hello-web` and `examples/hello-desktop`.

## Decisions

- **Wrapper application, not a key on the web app.** The web app must deploy unchanged. A top-level `desktop:` block on every Application, or a new root kind, was rejected: one breaks the one-root-doc rule and the other adds an Application key for one feature.
- **Identity on a built-in need.** The CLI and kernel know `Telo.DesktopHost` the way they know `Telo.DurableDirectory` and `Telo.PublicUrl`, so packaging never knows a module's kind. A flag on `telo package` was rejected: the analyzer and the editor cannot check it.
- **One need type and one module per host family.** `Telo.DesktopHost` and the future `Telo.MobileHost` each carry their own parameters and protocol generation, so neither family's change forces the other's. One shared `Telo.WindowHost` with a generic window module was rejected: it couples both families' parameters, protocol and release cadence. A future split of `mobile` into `android` / `ios` is likewise a new family.
- **The port lives on the need, not on the window.** The host binds before boot and cannot read `Desktop.Window`. One origin per app also keeps admission to one cookie.
- **`dock` is on the need, not the tray.** The packager writes `Info.plist` and reads only the need, never a module kind.
- **The need is read from the environment like every other.** Making it in-process only would turn it into a marker just one host can satisfy. `Desktop.Window` and `Desktop.Tray` could then be tested only against the real helper and a display. Socket handover and admission stay with `telo run`'s own host, because an inherited listening socket has no portable form on Windows.
- **`name` is a plain string.** It is the product name written into `Info.plist` and the PE version resource, which the packager writes once, in no language. The window `title` and tray texts stay `Text`.
- **`!module-path` is admitted in need parameters, not a module-relative plain string.** A plain string would be a relative host path, refused everywhere else, and no publish or package step would carry the file.
- **Uniqueness is a need-type key, not a desktop-specific check.** `Telo.MobileHost` needs the same rule, and the analyzer keeps no knowledge of one kind.
- **The protocol generation is a handshake, not a need constraint.** A need's `features` / `observes` check the constraint the app's author stated. The generation is the module's own requirement on the host, which no author writes.
- **No tray on Linux warns and shows the hidden windows.** Refusing would make an app unusable on stock GNOME for want of an optional icon.
- **State in the menu is `visible` / `enabled` / `checked`, never a computed label.** A computed label could not be a literal `Text`, so it could be neither translated nor checked for missing translations.
- **The tray icon's format is judged when the tray opens.** `telo check` only checks that the `!module-path` file exists, since the analyzer reads no file content and the packager reads no module kind.
- **The desktop host lives in the CLI, not the module.** Startup view, input form, boot errors and single instance happen before any resource exists. A helper spawned by a module's `native:` file could do none of them.
- **Socket handover over port 0.** Only a socket the host owns confines the server to loopback, puts admission in front of it and closes the pick-to-bind race, with the web app unchanged.
- **The helper is downloaded, not embedded,** to keep the CLI small. A packaged app embeds it, so it still runs offline.
- **A child reads its own environment.** `App.Instance` already inherits the parent's environment, so the wrapper supplies only what it fixes.

## Verify

1. `examples/hello-web/telo.yaml` is byte-identical in both builds, and its server binary binds `0.0.0.0:$PORT`.
2. `telo run ./examples/hello-desktop` opens a window showing the page and a tray icon. Closing the window hides it and the app keeps running. The tray's "Open Hello" and a second run both show it again, the second run exiting 0. "Quit" logs the same unwind as SIGTERM and exits 0.
3. With the web app's process killed, the tray's "Web app stopped" item appears without a restart. On GNOME without the AppIndicator extension the run logs `DESKTOP_TRAY_UNAVAILABLE`, and closing the window then stops the app. On macOS, `dock: false` leaves no Dock icon under `telo run` and writes `LSUIElement` into the packaged `Info.plist`.
4. `curl` to the port gets 403 without the cookie, with a forged `Host`, and from another OS user. Pages, EventSource and WebSocket work in the window. `Kernel.PortsResolved` shows `address: 127.0.0.1, suppliedBy: host`.
5. A variable of the web app that is set nowhere is asked for in a window naming `web`, and is refused under `--no-input`. A boot refusal is shown in the window.
6. `telo package ./examples/hello-desktop` writes `Hello.app` on macOS, a GUI `Hello.exe` with no console on Windows, and the ELF on Linux. Each starts offline with the child's whole closure in the payload, and the web app's durable directories land under `<data dir>/state/apps/web/needs/`.
7. A signed `Hello.exe` (signtool) still finds its payload.
8. `telo check` reports `NEED_DUPLICATE` for two needs, and `NEED_PARAMETERS_INVALID` for a `udp` or undeclared `port`, for parameters on a Library and for `icon: !cel …`. It reports `MODULE_PATH_NOT_FOUND` for an `icon` naming no file. `telo runner` refuses the entry with `ERR_NEED_UNMET`, naming `TELO_NEED_WINDOW__ENDPOINT` and `TELO_NEED_WINDOW__TOKEN`. `cli/rust` refuses it with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.
9. `modules/desktop/tests/` runs headless in CI: a `desktop-host-1` fixture supplies both fields through the environment, and the tests open and close a window and a tray, switch a menu item's `visible`, and dispatch an `invoke:` action. With the env supply, `telo run` starts no helper. A fixture speaking another generation gets `ERR_DESKTOP_HOST_PROTOCOL`. Setting only `TELO_NEED_WINDOW__ENDPOINT` gets `ERR_NEED_PARTIALLY_SUPPLIED`.
10. `telo package ./examples/hello-desktop` carries `icon.png` with no `files:` entry, and `telo needs report` lists the `window` need with its parameters and both variables.
11. Unverified before implementation:
   - wry sends a request header on the first navigation on WebView2, WKWebView and WebKitGTK;
   - `Http.Server` serves a handed-over connection;
   - the `tray-icon` and `muda` crates run on the helper's tao event loop on all three platforms, and a menu rebuilt at run time keeps its open state.

## Complete example after the change

`examples/hello-web/telo.yaml`, the unchanged web app:

```yaml
kind: Telo.Application
metadata: { name: HelloWeb, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>#<pin>
  Run: oci://ghcr.io/telorun/run@<version>#<pin>
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
```

`examples/hello-desktop/telo.yaml`, the desktop app:

```yaml
kind: Telo.Application
metadata: { name: HelloDesktop, version: 1.0.0 }
lang: en
imports:
  App: oci://ghcr.io/telorun/app@<version>#<pin>
  Desktop: oci://ghcr.io/telorun/desktop@<version>#<pin>
ports:
  http: { env: HELLO_PORT }
needs:
  window:
    kind: Telo.DesktopHost
    parameters:
      identifier: run.telo.examples.hello
      name: Hello
      icon: !module-path icon.png
      port: http
targets:
  - !ref web
  - !ref mainWindow
  - !ref tray
---
kind: App.Instance
metadata: { name: web }
source: ../hello-web
ports: { http: !cel "ports.http" }
---
kind: Desktop.Window
metadata: { name: mainWindow }
host: !ref window
title: Hello
size: { width: 480, height: 320 }
onClose: hide
---
kind: Desktop.Tray
metadata: { name: tray }
host: !ref window
icon: !module-path tray.png
template: true
tooltip: Hello
action: { open: !ref mainWindow }
menu:
  - { label: Open Hello, action: { open: !ref mainWindow } }
  - label: Web app stopped
    enabled: false
    visible: !cel "resources.web.status.exitCode != null"
  - separator: {}
  - { label: Quit, action: { quit: {} } }
```

Run it with `telo run ./examples/hello-desktop`. Ship it with `telo package ./examples/hello-desktop --out dist/Hello`.
