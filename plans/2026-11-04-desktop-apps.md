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

## Solution

**The web app stays unchanged.** A separate **wrapper `Telo.Application`** runs it through `App.Instance` and declares its windows. The same web app keeps deploying to a server through `telo run`, runners, Docker or a server binary.

**`Telo.DesktopHost`** is a new kernel-declared need type with `supply: root` and `unique: true`:
- Parameters:
  - `identifier`: reverse-DNS.
  - `productName`: a plain string.
  - `icon`: a `Telo.HostPath` with `entry: file` and `mediaType: image/png`, written `!module-path`.
  - `port`: a `tcp` key of the root's `ports:`.
  - `showInDock`: a boolean, default `true`. `false` gives a macOS app no Dock icon and no app menu (`LSUIElement`), for an app that lives in the menu bar. Other platforms ignore it.
  - `callbackPaths`: a list of literal app-relative paths an external identity provider returns to (`/auth/callback`), each starting with `/` and holding no query or fragment. Empty by default.
- Fields: `endpoint`, a `Telo.Url` with scheme `unix` or `npipe`, and `token`, which is `x-telo-sensitive`. They are the desktop host's control channel.
- It is supplied like every root need. Its fields are read from the environment (`TELO_NEED_<NEED>__ENDPOINT` / `TELO_NEED_<NEED>__TOKEN`, or the names its `env:` binds), and when neither is set, `telo run` supplies it as the desktop host (below). One set and not the other is `ERR_NEED_PARTIALLY_SUPPLIED`.
- `telo needs report` lists it with its parameters and both variables.

**Three generic additions** come with it:
- **`unique: true`** on a `Telo.NeedType`: a module declares at most one need of the type. A second one is `NEED_DUPLICATE` / `ERR_NEED_DUPLICATE`, naming both needs.
- **`!module-path` in need parameters.** A parameter whose schema is a `Telo.HostPath` accepts a `!module-path`, resolved against the declaring module at load. It is a module file claim like any other: `telo publish` / `telo package` carry the file, a missing file is `MODULE_PATH_NOT_FOUND`, and a directory where `entry: file` is declared is `HOST_PATH_ENTRY_MISMATCH`. Any other tag in `parameters:` stays `NEED_PARAMETERS_INVALID`.
- **`mediaType` on a host path.** `x-telo-type: { name: Telo.HostPath, entry: file, mediaType: image/png }` says the file's leading bytes carry that media type's signature. The signatures are data in the built-in vocabulary, and a token with none is `X_TELO_TYPE_ARGUMENT_INVALID`. `telo check` judges a `!module-path` by a bounded read of the file's head through the manifest source (a source that cannot read leaves it to the runtime, as `entryAt` does), the kernel judges every value at creation and an Application variable at load, and a variable passed to a library input declaring another `mediaType` is refused like a mismatched `entry`. A mismatch is `HOST_PATH_CONTENT_MISMATCH` / `ERR_HOST_PATH_CONTENT_MISMATCH`, naming the path, the media type found and the one declared. An absent path is never refused.

**`modules/desktop`** is a new stdlib module. It talks only the desktop-host protocol (`kernel/specs/desktop-host.md`, generation `desktop_host-1`) on the control channel:
- **Framing.** The controller protocol's framed carrier, byte for byte: its frame, its 16 MiB bound, typed-frame JSON in the meta, `ok` / `error` responses and notifications. The envelope has three members, `id`, `type` and `payload` — one connection serves one fulfilment, so there is no `session`. The module end mints odd ids, the host end even ones. The message set is written in the spec.
- **Handshake.** The first message is the module's `Host.Hello` request, carrying `generation` and `token`. The host checks the token first: a wrong one gets an `error` response with `ERR_DESKTOP_HOST_TOKEN_INVALID` and the connection is closed. Otherwise the host answers with its own `generation`, never negotiating down, and the module refuses a mismatch with `ERR_DESKTOP_HOST_INCOMPATIBLE`, naming both generations. The token appears only in `Host.Hello`.

It declares four kinds.

**`Desktop.Window`** is a `Telo.Service` with:
- `host`: a reference slot of type `Telo.DesktopHost`;
- `path` (default `/`);
- `title` (a `Text`; the page's document title replaces it once loaded);
- `size`, `minSize`, `resizable`;
- `visible` (default `true`): `false` starts the window hidden;
- `onClose`: `close` (default) or `hide`. A hidden window keeps running and is shown again by `Desktop.ShowWindow`, or by a second launch or a Dock click when the start showed it (below).

`run()` opens the window and its inverse closes it. Every window opens on the need's one origin.

**`Desktop.TrayIcon`** is a `Telo.Service` for an icon in the Windows notification area, the macOS menu bar or a Linux AppIndicator. It has:
- `host`: a reference slot of type `Telo.DesktopHost`;
- `icon`: a `Telo.HostPath` with `entry: file` and `mediaType: image/png`, written `!module-path` and scaled by the host. `monochrome: true` draws it as a macOS template image that follows the menu bar's light or dark appearance;
- `tooltip`: a `Text`;
- `action`: what a primary click on the icon does on Windows. On macOS and Linux a click always opens the menu;
- `menu`: a list of entries, each `{ type: item, label, action?, enabled? }` or `{ type: separator }`. `label` is a literal `Text`; `enabled` is a literal boolean, default `true`. An item with no `action` does nothing when chosen.

An `action` is the shared invoke shape `{ invoke, inputs? }`: an inbound trigger (`use: trigger.inbound`) dispatching any invocable in the wrapper app, with `inputs` checked against its contract. A failure is logged and the menu stays usable. The module adds two invocables for the actions every tray needs:
- **`Desktop.ShowWindow`**, with a `window` slot of kind `Desktop.Window`: shows and focuses that window.
- **`Desktop.Quit`**, with a `host` slot of type `Telo.DesktopHost`: asks the host for the same graceful stop as SIGTERM.

A host family is a pair: one kernel-declared need type and one stdlib module, each with its own protocol and generation. Mobile is a separate family (`Telo.MobileHost`, `modules/mobile`, `mobile_host-1`) with its own plan. Only the generic kernel mechanisms below (port handover, admission, child applications) are shared.

**`telo run` is the desktop host** whenever the root declares a `Telo.DesktopHost` need and the environment sets neither of its fields. A packaged start is `telo run` of itself, so the packaged app behaves the same, by construction. Before anything initializes, the host:
- takes a single-instance lock per `identifier`: a local socket (a named pipe on Windows) in the per-user app directory (below), whose liveness is tested by connecting, so one a crashed instance left behind is replaced. A second start connects to it and asks for its windows: a second start, like a click on the macOS Dock icon, shows again every window the start showed — those declared `visible: true`, and the `visible: false` ones when no tray took their place (below) — focuses the first of them opened, prints one line naming the running instance's process and the manifest or packaged app it runs, and exits 0. A window the start did not show stays as it is.
- starts the `telo-desktop-host` helper and shows its startup view. Every window opens in a webview data store of the app's own — `<per-user app directory>/desktop-host/webview/` on Windows and Linux, a WebKit store whose identifier is a UUIDv5 of `identifier` on macOS — and never in a shared one, which is what keeps two Telo apps' cookies and browser storage apart.
- binds `127.0.0.1` for the need's `port` on a port that stays the same across launches, so the window's origin — and with it the web app's `localStorage`, IndexedDB and permission grants — does too. When the root's `ports:` entry declares a `default:`, the host binds that number, which is what lets an author register an exact redirect address with an identity provider. Otherwise it binds the port recorded in `<per-user app directory>/desktop-host/port`, OS-assigned and recorded on the first start. When the port it tries cannot be bound, or the file holds no port, a new OS-assigned one is recorded and the run logs a `DESKTOP_ORIGIN_CHANGED` warning naming both origins. The file is read and replaced only under the lock. The host then supplies that number to the root's port by name, and supplies the need.
- asks for the root's missing inputs in a form in the window. `--no-input` refuses instead, as today.
- shows a boot refusal in the window, with the diagnostics `telo run` prints, and exits 1.

At run time:
- **Shutdown.** The app takes the same graceful stop as SIGTERM on `Desktop.Quit`, on OS quit and logoff, and when no window is visible while no tray icon is open. An app that ends on its own closes its windows and tray icons, and its exit status is the host's.
- **No tray on Linux.** Before boot the host checks the session bus for a StatusNotifierWatcher (stock GNOME has none). Without one, each `Desktop.TrayIcon` logs a `DESKTOP_TRAY_UNAVAILABLE` warning saying AppIndicator support is missing, shows no icon and does not count as open, and every window declared `visible: false` is shown, so the app stays reachable.
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

**A host supplied through the environment** — another shell embedding Telo, or a test fixture speaking `desktop_host-1` — gets the control channel only. `telo run` starts no helper, takes no lock, hands over no socket and admits nothing. The app's ports bind as they do without the need, read from their own variables, and fronting them is that host's concern.

**Port handover.** The kernel gains a generic **host-supplied listener**:
- A server configured with a port number the host holds a socket for serves that socket and binds nothing itself. The socket follows the number into an `App.Instance` child.
- `Kernel.PortsResolved` entries gain `address` and `suppliedBy: host`.
- Until a server claims the socket, the host holds each admitted connection. One still unclaimed when startup ends — with no server for the port, or a boot that failed — is answered `503` with the window's startup or boot-refusal view, and a host socket no server claimed by the end of startup is a warning naming the port key. A server that stops gives its claim back, and connections are held again until it claims anew.

It is three new controller-protocol messages in generation `telo-10`, adopted by `http-server`, which declares a `requires: telo:` floor on the release carrying `telo-10`. No message carries an OS handle, so every byte of a handed-over connection is relayed through the kernel, a cost a local app can carry:
- `Listener.Claim` (controller to kernel) asks whether the host holds a socket for a `tcp` port number. It answers with a listener handle, or "not held", and the server then binds as it does today.
- `Listener.Accept` (kernel to controller) hands one admitted connection over as two one-way channels on the existing channel messages, inbound and outbound, under the channel purpose `connection`. The inbound channel begins with the bytes the host already read during admission.
- `Listener.Release` releases the handle. It is the inverse of the claim.

**Admission.** The host admits each connection on its first request, before handing it on:
- `Host` must be `127.0.0.1:<port>`, and `Origin` must be absent or that origin.
- For each window it opens, the host gives the helper a single-use code over its link to the helper, and the helper navigates to the window's `path` with the query parameter `_telo.window=<code>`. The host answers that request itself: `303` to the same path and query without the parameter, with `Set-Cookie: telo-window=<token>; HttpOnly; SameSite=Strict; Path=/`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- Every other connection's first request must carry the `telo-window` cookie, whose value is the per-launch admission secret. It is the host's alone — distinct from the need's `token`, which secures the control channel — and never reaches the manifest's scope. Once admitted, a connection is handed over whole and its later requests reach the server unread.
- An armed return to a `callbackPaths` entry is the one request admitted without the cookie (External sign-in, above).
- A code that is unknown or already used, and anything else, gets `403` and the connection is closed.
- Neither secret appears in argv or a URL, and both join the root's redaction set.

**The helper** is a Rust wry/tao crate at `cli/rust/desktop-host`, carrying the CLI's version. It talks to `telo run` over the same framed carrier, with a message set internal to one release:
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

**Child applications** (generic, every supervisor app benefits). A child is one started by a resource whose kind declares `x-telo-application-source`:
- `telo package` follows every `x-telo-application-source` edge. The child's manifest, files, import closure, built local modules and the portability check go into the payload, and a child's relative `source:` resolves inside the unpacked tree.
- A child loads against the payload's sealed cache.
- A child under a parent with `TELO_HOST_STATE_DIR` gets `<state dir>/apps/<path>`, where the path is the resource's module path and name, `.`-joined as a need path is (`apps/web` at the root, `apps/Admin.web` under alias `Admin`). That directory is the child's own `TELO_HOST_STATE_DIR`, so its own children nest beneath it. The orphan rule covers `apps/` as it covers `needs/`, so renaming the instance orphans its directory as renaming a need does.
- A child never asks. A missing child input is refused at the child's start, as today, and the refusal names the instance and the fix: supply it under that instance's `variables:` / `secrets:` / `ports:` / `needs:`, or declare it on the root, which asks.

**Static checks:**
- A `Telo.DesktopHost` declared with parameters on a Library, a `port` that is not a `tcp` key of `ports:`, or a `callbackPaths` entry that does not start with `/` or holds a query or fragment, is `NEED_PARAMETERS_INVALID`, as for `Telo.PublicUrl`.
- A module with two needs of a `unique` type is `NEED_DUPLICATE` / `ERR_NEED_DUPLICATE`, with both rows in `tests/check-run-agreement.yaml`.
- A `!module-path` parameter naming nothing is `MODULE_PATH_NOT_FOUND`, one naming a directory `HOST_PATH_ENTRY_MISMATCH`, and any other tag in `parameters:` `NEED_PARAMETERS_INVALID`, each with both rows in `tests/check-run-agreement.yaml`.
- `Desktop.Window.host`, `Desktop.TrayIcon.host` or `Desktop.Quit.host` naming anything but a `Telo.DesktopHost` need, or `Desktop.ShowWindow.window` naming anything but a `Desktop.Window`, is `REFERENCE_KIND_MISMATCH`.
- An action's `inputs` are checked against the invocable's `inputType`.
- A `Desktop.TrayIcon.icon` or `Telo.DesktopHost.icon` whose file is not a PNG is `HOST_PATH_CONTENT_MISMATCH` / `ERR_HOST_PATH_CONTENT_MISMATCH`, with both rows in `tests/check-run-agreement.yaml` and rows in the host-path conformance vectors, which both kernels answer.

**Hosts that cannot run a desktop app:**
- A runner never supplies `Telo.DesktopHost`, so it refuses with `ERR_NEED_UNMET`, naming both variables as for any need.
- `kernel/rust` and `cli/rust` refuse it with `ERR_UNSUPPORTED_MANIFEST_FEATURE`. This is polyglot debt, as are the `telo-10` messages in `sdk/rust` / `kernel/rust`. `mediaType` is not debt: `kernel/rust` answers the new host-path conformance rows like the Node kernel.

**Docs and bookkeeping:**
- `kernel/specs/desktop-host.md` (new), including the framing, the handshake, the message set and the admission code exchange; `telo-10` in `kernel/specs/controller-protocol.md` and `sdk/controller-protocol/`;
- amendments to `kernel/specs/packaged-application.md`;
- `modules/desktop` docs (windows, tray icons, actions, external sign-in), `README.md`, `LICENSE` and `license: MIT`, with a `requires: telo:` floor;
- `http-server`'s `requires: telo:` floor and docs (serving a host-supplied socket);
- `app` module docs (the child state directory; a child never asks);
- the packaging and providing-needs guides, the need-types guide (`unique`, `!module-path` parameters) and the value-types docs (`mediaType`);
- a benefits-ledger entry, "Desktop apps", which names external sign-in;
- an external sign-in section in the providing-needs guide;
- the authoring-agent primer and the hub `build_ui` guide;
- the root and CLI `CLAUDE.md` (the host-path section gains `mediaType`; `cli/rust/desktop-host` is a second crate with no Node twin, beside `telorun-abi`);
- `examples/hello-web` and `examples/hello-desktop`, the latter with a `requires: telo:` floor.

## Decisions

- **Wrapper application, not a key on the web app.** The web app must deploy unchanged. A top-level `desktop:` block on every Application, or a new root kind, was rejected: one breaks the one-root-doc rule and the other adds an Application key for one feature.
- **Identity on a built-in need.** Packaging reads it the way the kernel reads `Telo.DurableDirectory` and `Telo.PublicUrl`, never a module's kind. A flag on `telo package` was rejected: the analyzer and the editor cannot check it.
- **One need type and one module per host family.** One shared `Telo.WindowHost` with a generic window module was rejected: it couples the desktop and mobile families' parameters, protocol and release cadence.
- **The port lives on the need, not on the window.** The host binds before boot and cannot read `Desktop.Window`. One origin per app also keeps admission to one cookie.
- **The need is read from the environment like every other.** Made in-process only, `Desktop.Window` and `Desktop.TrayIcon` could be tested only against the real helper and a display. Socket handover and admission stay with `telo run`'s own host.
- **`!module-path` in need parameters, not a module-relative plain string.** A plain string would be a relative host path, refused everywhere else, and no publish or package step would carry the file.
- **Uniqueness is a need-type key, not a desktop-specific check.** `Telo.MobileHost` needs the same rule, and the analyzer keeps no knowledge of one kind.
- **The protocol generation is a handshake, not a need constraint.** It is the module's own requirement on the host, which no app author writes.
- **A connection crosses as channel bytes, not an OS handle.** A handle has no form on the in-process carrier and none portable across processes on Windows.
- **Admission rides a one-time code in the first URL, not a request header.** A URL is the one carrier every webview is sure to send; the code is single-use and is not the token, so history and `Referer` leak nothing.
- **Only the root asks for a missing input.** A child starts whenever its resource runs — after a crash, on a restart — and a question there would block it on a person; lifting the input to the root asks once, before boot.
- **Other origins open in the system browser, and sign-in returns through loopback.** An embedded sign-in page is what RFC 8252 forbids and Google refuses. A loopback return keeps the web app's own redirect address, works under `telo run` on every platform and carries a form POST. Replaying it into the window keeps the session in the window's cookies rather than the browser's. A private-use URL scheme is not part of this plan: it needs the web app reconfigured and per-platform registration, and macOS registers one only for an app bundle.
- **The control channel reuses the controller protocol's framing.** A shell or fixture implements one frame codec, and the desktop surface will carry raw bytes, which a JSON-lines wire could not.
- **Menus are literal.** A menu whose items follow app state needs a kernel push of resource changes to controllers, which is not part of this plan.
- **No tray on Linux warns and shows the hidden windows.** Refusing would make an app unusable on stock GNOME for want of an optional icon.
- **An icon's format is a host-path constraint, judged by `telo check` and at creation alike.** Its size stays a packaging refusal: only the packager needs a 1024 px square, and a static size check would need a dimension reader per media type.
- **The desktop host lives in the CLI, not the module.** Startup view, input form, boot errors and single instance happen before any resource exists.
- **Socket handover on a remembered port.** Only a socket the host owns confines the server to loopback, puts admission in front of it and closes the pick-to-bind race, with the web app unchanged. Keeping the port keeps the origin, which browser storage is keyed by; a custom-scheme origin would break WebSocket and cookies on WKWebView. The port is remembered rather than declared because a declared one collides between users of one machine, so a declared `default:` is used only by apps that need an exact redirect address, and a collision still falls back.
- **Apps are isolated by their webview store, not by the cookie's name.** Cookies are sent by host, not port, so in a shared store a port-named cookie would still reach the other app's server. macOS has a per-app store only from 14, hence the floor.
- **The helper is downloaded, not embedded,** to keep the CLI small. A packaged app embeds it, so it still runs offline.

## Verify

1. `examples/hello-web/telo.yaml` is byte-identical in both builds, and its server binary binds `0.0.0.0:$PORT`.
2. `telo run ./examples/hello-desktop` opens a window showing the page and a tray icon. Closing the window hides it and the app keeps running. The tray's "Open Hello" and a second run both show it again, the second run exiting 0. "Settings", declared `visible: false`, opens only from the tray, and a second run leaves it hidden even after it was opened from the tray and hidden again. "Quit" logs the same unwind as SIGTERM and exits 0.
3. "Write status to log" writes its line through `Console.writeLine`. On GNOME without the AppIndicator extension the run logs `DESKTOP_TRAY_UNAVAILABLE`, "Settings" is shown at start, a second run shows both windows, and closing both stops the app. On macOS, `showInDock: false` leaves no Dock icon under `telo run` and writes `LSUIElement` into the packaged `Info.plist`.
4. `curl` to the port gets 403 without the cookie, with a forged `Host`, with a replayed `_telo.window` URL, and from another OS user. The page's `location` never shows `_telo.window`. Pages, EventSource and WebSocket work in the window. Two desktop apps run side by side under `telo run`, each keeping its own admission, and neither server receives the other's cookie. A value a page writes to `localStorage` is there after quit and restart, on the same port. With that port occupied, the next start logs `DESKTOP_ORIGIN_CHANGED` and records the new port. On macOS 13 `telo run` is refused with `ERR_DESKTOP_HOST_UNAVAILABLE` and the packaged app is refused by macOS. `Kernel.PortsResolved` shows `address: 127.0.0.1, suppliedBy: host`.
5. A web-app variable set nowhere is refused at `web`'s start, naming `web` and the fix, and is never asked for. The same variable declared on the wrapper and passed through is asked for in the window, and refused under `--no-input`. A boot refusal is shown in the window.
6. `telo package ./examples/hello-desktop` writes `Hello.app` on macOS, a GUI `Hello.exe` with no console on Windows, and the ELF on Linux. Each starts offline with the child's whole closure in the payload, and a `Telo.DurableDirectory` need `data` of the web app lands at `<data dir>/state/apps/web/needs/data`. A fixture with a root `web` and an imported library's `Admin.web` gets two directories.
7. A signed `Hello.exe` (signtool) still finds its payload.
8. `telo check` reports `NEED_DUPLICATE` for two needs, and `NEED_PARAMETERS_INVALID` for a `udp` or undeclared `port`, for parameters on a Library and for `icon: !cel …`. It reports `MODULE_PATH_NOT_FOUND` for an `icon` naming no file and `HOST_PATH_CONTENT_MISMATCH` for a JPEG tray icon, which `telo run` refuses with `ERR_HOST_PATH_CONTENT_MISMATCH`. `telo runner` refuses the entry with `ERR_NEED_UNMET`, naming `TELO_NEED_DESKTOP_HOST__ENDPOINT` and `TELO_NEED_DESKTOP_HOST__TOKEN`. `cli/rust` refuses it with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.
9. `modules/desktop/tests/` runs headless in CI: a `desktop_host-1` fixture, written from the spec alone, supplies both fields through the environment, and the tests open and close a window and a tray icon and dispatch an action with `inputs`. With the env supply, `telo run` starts no helper. A fixture speaking another generation gets `ERR_DESKTOP_HOST_INCOMPATIBLE`, and a wrong token is refused with `ERR_DESKTOP_HOST_TOKEN_INVALID` before any window message is served. Setting only `TELO_NEED_DESKTOP_HOST__ENDPOINT` gets `ERR_NEED_PARTIALLY_SUPPLIED`.
10. `telo package ./examples/hello-desktop` carries `icon.png` and `tray.png` with no `files:` entry, and `telo needs report` lists the `desktopHost` need with its parameters and both variables.
11. `pnpm run check:controller-protocol` passes with `telo-10`, whose carrier-equivalence vectors include a connection whose inbound data starts with replayed bytes. `Http.Server` serves a handed-over connection, WebSocket upgrade included (Node's HTTP server accepts any duplex stream as a connection).
12. A fixture identity provider with a GET callback, and one answering with `form_post`, signs the window in under `telo run` and in the packaged app, also when the window showed an error page before the return; the system browser shows the return page, and the window ends signed in. A fixture matching the redirect address exactly works when the root's port declares a `default:`. A replayed, unarmed or undeclared return gets 403, as does a second return after one external navigation.
13. A window opened before the web app's server is up shows the page once it is; with the server never starting, the window shows the boot-refusal view and a request gets `503`. A second start prints the running instance's process and source.

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

`examples/hello-desktop/telo.yaml`, the desktop app, with `icon.png` (1024 × 1024) and `tray.png` beside it. `desktop` is not published yet, so its import carries no pin until its first release:

```yaml
kind: Telo.Application
metadata: { name: HelloDesktop, version: 1.0.0 }
lang: en
requires: { telo: ">=0.130.0" }
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

```
$ telo needs report ./examples/hello-desktop
desktopHost  DesktopHost (Telo)
  declared by ./
  parameters {"identifier":"run.telo.examples.hello","productName":"Hello","icon":"./icon.png","port":"http","showInDock":false}
  endpoint  TELO_NEED_DESKTOP_HOST__ENDPOINT  derived, required
  token  TELO_NEED_DESKTOP_HOST__TOKEN  derived, required, sensitive
```

Packaging, Before. Today the wrapper can only run the web app — `examples/supervisor/telo.yaml`:

```yaml
kind: Telo.Application
metadata: { name: Supervisor, version: 1.0.0 }
imports:
  App: oci://ghcr.io/telorun/app@0.5.1#sha256-A_gkbdHIqYdg93KYHDkjWl7zGnnYBN8dC7TEzMBMUmk
ports:
  http: { env: PORT, default: 8080 }
targets:
  - !ref web
---
kind: App.Instance
metadata: { name: web }
source: ../hello-web
ports: { http: !cel "ports.http" }
```

The child is not in the payload, so the packaged app fails at start:

```
$ telo package ./examples/supervisor --out dist/Supervisor
$ TELO_APP_CLI=1 dist/Supervisor package inspect dist/Supervisor
{
  "format": 1,
  "app": { "name": "Supervisor", "version": "1.0.0" },
  "entry": "app/telo.yaml",
  "platform": { "os": "linux", "arch": "amd64", "libc": "gnu", "abi": "node-127" },
  "telo": "0.129.0",
  "analysisKey": "sha256:5f0c6b1e9d2a47c3b8e1f4a6d7c9b2e0a3f5d8c1b4e7a9f2c6d3b8e5a1f4c7d0",
  "modules": [
    { "source": "oci://ghcr.io/telorun/app@0.5.1", "name": "App", "version": "0.5.1", "delivery": "artifact" }
  ],
  "payload": { "bytes": 41873920, "digest": "sha256:9a1e7c3f5b2d8e4a6c0f1b3d5e7a9c2e4f6b8d0a1c3e5f7b9d2a4c6e8f0b1d3a5", "placement": "trailer" }
}
$ dist/Supervisor
[ERR_IMPORT_UNRESOLVED] App.Instance/web: source '../hello-web' resolves to no manifest
$ echo $?
1
```

After, the same `examples/supervisor` packages with the child's closure, and starts:

```
$ telo package ./examples/supervisor --out dist/Supervisor
$ TELO_APP_CLI=1 dist/Supervisor package inspect dist/Supervisor
{
  "format": 1,
  "app": { "name": "Supervisor", "version": "1.0.0" },
  "entry": "app/telo.yaml",
  "platform": { "os": "linux", "arch": "amd64", "libc": "gnu", "abi": "node-127" },
  "telo": "0.130.0",
  "analysisKey": "sha256:7b2e4d6f8a1c3e5b7d9f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1b3d5f7a9c2e4b6",
  "modules": [
    { "source": "oci://ghcr.io/telorun/app@0.5.1", "name": "App", "version": "0.5.1", "delivery": "artifact" },
    { "source": "../hello-web", "name": "HelloWeb", "version": "1.0.0", "delivery": "local" },
    { "source": "oci://ghcr.io/telorun/http-server@0.42.0", "name": "Http", "version": "0.42.0", "delivery": "artifact" },
    { "source": "oci://ghcr.io/telorun/run@0.32.0", "name": "Run", "version": "0.32.0", "delivery": "artifact" }
  ],
  "payload": { "bytes": 48234496, "digest": "sha256:1d3f5a7c9e2b4d6f8a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8b1d3f5a7c9e2b4d6f8", "placement": "trailer" }
}
$ PORT=8080 dist/Supervisor &
$ curl -s http://localhost:8080/
<h1>Hello, world!</h1>
```

The desktop wrapper's index also names its identity:

```
$ telo package ./examples/hello-desktop --out dist/Hello
$ TELO_APP_CLI=1 dist/Hello package inspect dist/Hello
{
  "format": 1,
  "app": { "name": "HelloDesktop", "version": "1.0.0" },
  "entry": "app/telo.yaml",
  "platform": { "os": "linux", "arch": "amd64", "libc": "gnu", "abi": "node-127" },
  "telo": "0.130.0",
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

The helper's release assets, for release `0.130.0`:

```
telo-desktop-host-0.130.0-linux-amd64-gnu
telo-desktop-host-0.130.0-linux-arm64-gnu
telo-desktop-host-0.130.0-darwin-amd64
telo-desktop-host-0.130.0-darwin-arm64
telo-desktop-host-0.130.0-windows-amd64.exe
telo-desktop-host-0.130.0-windows-arm64.exe
```

### Static refusals

`broken/telo.yaml`, with `tray.jpg` (a JPEG) beside it:

```yaml
kind: Telo.Application
metadata: { name: Broken, version: 1.0.0 }
imports:
  Desktop: oci://ghcr.io/telorun/desktop@0.1.0
variables:
  icon: { env: ICON, type: string }
ports:
  http: { env: PORT }
  metrics: { env: METRICS_PORT, protocol: udp }
needs:
  desktopHost:
    kind: Telo.DesktopHost
    parameters: { identifier: run.telo.broken, productName: Broken, icon: !module-path missing.png, port: metrics, callbackPaths: [auth/callback] }
  second:
    kind: Telo.DesktopHost
    parameters: { identifier: run.telo.broken2, productName: Broken, icon: !cel "variables.icon", port: http }
targets:
  - !ref mainWindow
  - !ref otherWindow
  - !ref tray
---
kind: Desktop.Window
metadata: { name: mainWindow }
host: !ref otherWindow
---
kind: Desktop.Window
metadata: { name: otherWindow }
host: !ref desktopHost
---
kind: Desktop.TrayIcon
metadata: { name: tray }
host: !ref desktopHost
icon: !module-path tray.jpg
tooltip: Broken
menu:
  - { type: item, label: Open, action: { invoke: { kind: Desktop.ShowWindow, window: !ref tray } } }
  - { type: item, label: Quit, action: { invoke: { kind: Desktop.Quit, host: !ref desktopHost } } }
```

```
$ telo check ./broken
telo.yaml:13:29  error  Telo.Application/Broken: needs.desktopHost.parameters.icon: 'missing.png' names no file in this module  MODULE_PATH_NOT_FOUND
telo.yaml:13:62  error  Telo.Application/Broken: needs.desktopHost.parameters.port: 'metrics' is a udp port; a Telo.DesktopHost names a tcp key of ports:  NEED_PARAMETERS_INVALID
telo.yaml:13:94  error  Telo.Application/Broken: needs.desktopHost.parameters.callbackPaths[0]: 'auth/callback' must start with '/'  NEED_PARAMETERS_INVALID
telo.yaml:14:3   error  Telo.Application/Broken: needs 'desktopHost' and 'second' are both Telo.DesktopHost, which a module declares at most once  NEED_DUPLICATE
telo.yaml:16:84  error  Telo.Application/Broken: needs.second.parameters.icon: a need parameter takes a literal or !module-path, not !cel  NEED_PARAMETERS_INVALID
telo.yaml:25:7   error  Desktop.Window/mainWindow: host: 'otherWindow' is a Desktop.Window; this slot takes a Telo.DesktopHost  REFERENCE_KIND_MISMATCH
telo.yaml:34:7   error  Desktop.TrayIcon/tray: icon: 'tray.jpg' is image/jpeg; this slot takes image/png  HOST_PATH_CONTENT_MISMATCH
telo.yaml:37:79  error  Desktop.TrayIcon/tray: menu[0].action.invoke.window: 'tray' is a Desktop.TrayIcon; this slot takes a Desktop.Window  REFERENCE_KIND_MISMATCH

8 errors
```

The same tray icon under `telo run`, where the analysis was skipped:

```
[ERR_HOST_PATH_CONTENT_MISMATCH] Desktop.TrayIcon/tray: icon: '/home/me/broken/tray.jpg' is image/jpeg; this slot takes image/png
```

### The generic additions, in a library

A library declaring its own need type with `unique: true` and a host-path parameter, `printing/telo.yaml`:

```yaml
kind: Telo.Library
metadata: { name: Printing, version: 0.1.0, description: Print documents through the one label printer an application drives. }
exports: { kinds: [LabelPrinter] }
---
kind: Telo.NeedType
metadata: { name: LabelPrinter, description: The label printer an application prints through, at most one per module, with the logo printed on every label. }
unique: true
fields:
  device: { type: string }
required: [device]
parameters:
  type: object
  additionalProperties: false
  properties:
    logo: { x-telo-type: { name: Telo.HostPath, entry: file, mediaType: image/png } }
```

An application using it, `labels/telo.yaml`, with `logo.png` beside it:

```yaml
kind: Telo.Application
metadata: { name: Labels, version: 1.0.0 }
imports:
  Printing: ../printing
needs:
  printer:
    kind: Printing.LabelPrinter
    parameters: { logo: !module-path logo.png }
```

A second `Printing.LabelPrinter` need in `labels` is `NEED_DUPLICATE`; a `logo.png` that is a JPEG, or `logo: !module-path assets` naming a directory, is refused:

```
$ telo check ./labels
telo.yaml:8:29  error  Telo.Application/Labels: needs.printer.parameters.logo: 'logo.png' is image/jpeg; this slot takes image/png  HOST_PATH_CONTENT_MISMATCH

1 error
$ telo check ./labels     # with logo: !module-path assets
telo.yaml:8:29  error  Telo.Application/Labels: needs.printer.parameters.logo: 'assets' is a directory; this slot takes a file  HOST_PATH_ENTRY_MISMATCH

1 error
```

### Hosts that refuse

A runner session for `examples/hello-desktop` fails its start with:

```
[ERR_NEED_UNMET] need 'desktopHost' (Telo.DesktopHost) is required and not supplied: set TELO_NEED_DESKTOP_HOST__ENDPOINT and TELO_NEED_DESKTOP_HOST__TOKEN
```

On macOS 13:

```
$ telo run ./examples/hello-desktop
[ERR_DESKTOP_HOST_UNAVAILABLE] cannot start the desktop host: macOS 14 or later is required (this is macOS 13.6)
```

With the helper not in the cache and its download failing:

```
$ telo run ./examples/hello-desktop
[ERR_DESKTOP_HOST_UNAVAILABLE] cannot start the desktop host: telo-desktop-host-0.130.0-linux-amd64-gnu could not be downloaded (HTTP 503 from github.com)
```

On a Linux machine with no display:

```
$ telo run ./examples/hello-desktop
[ERR_DESKTOP_HOST_UNAVAILABLE] cannot start the desktop host: no display (neither WAYLAND_DISPLAY nor DISPLAY is set)
$ echo $?
1
```

A web-app variable that nothing supplies — say `hello-web` declared `greeting: { env: GREETING, type: string }` — is refused at `web`'s start, and never asked for:

```
[ERR_MANIFEST_VALIDATION_FAILED] App.Instance/web: variable 'greeting' of ../hello-web has no value: supply it under web's variables:, or declare it on Telo.Application/HelloDesktop and pass it through, which asks for it
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

Renaming the instance from `web` to `site` orphans `apps/web`, and the next start, which would create `apps/site`, is refused:

```
[ERR_NEED_ORPHANED] TELO_HOST_STATE_DIR holds 'apps/web', which no application of this one names, and this load would create 'apps/site' for 'site'. A renamed instance gets a new path and so a new, empty directory: move the old directory to the new path to keep its files, or delete it.
```

### A host supplied through the environment

`.env` of a test that runs the app against a `desktop_host-1` fixture:

```
TELO_NEED_DESKTOP_HOST__ENDPOINT=unix:///tmp/telo-desktop-fixture/control.sock
TELO_NEED_DESKTOP_HOST__TOKEN=f3b9c1d7e2a84b6c9d0e1f2a3b4c5d6e
PORT=18080
```

`telo run` then starts no helper and the web app binds `PORT` itself. With only the endpoint set:

```
[ERR_NEED_PARTIALLY_SUPPLIED] need 'desktopHost' (Telo.DesktopHost) is partly supplied: TELO_NEED_DESKTOP_HOST__ENDPOINT is set, TELO_NEED_DESKTOP_HOST__TOKEN is not
```

Against a fixture speaking another generation:

```
[ERR_DESKTOP_HOST_INCOMPATIBLE] the desktop host at unix:///tmp/telo-desktop-fixture/control.sock speaks desktop_host-2; this module speaks desktop_host-1
```

### The control channel

Each message is one frame of the controller protocol's framed carrier; shown here is the meta of each, as JSON. The module's first request and the host's answer:

```
→ { "id": 1, "payload": { "generation": "desktop_host-1", "token": "f3b9c1d7e2a84b6c9d0e1f2a3b4c5d6e" }, "type": "Host.Hello" }
← { "id": 1, "payload": { "ok": { "generation": "desktop_host-1" } }, "type": "Host.Hello" }
```

A wrong token:

```
→ { "id": 1, "payload": { "generation": "desktop_host-1", "token": "0000" }, "type": "Host.Hello" }
← { "id": 1, "payload": { "error": { "code": "ERR_DESKTOP_HOST_TOKEN_INVALID", "message": "the token does not match this host's" } }, "type": "Host.Hello" }
```

The connection is then closed.

After the handshake, `mainWindow` and `settingsWindow` open, the tray icon opens with its menu, the user chooses "Settings" and then "Quit". The module end sends requests with odd ids; the host's notifications carry even ones:

```
→ { "id": 3, "payload": { "window": "mainWindow", "path": "/", "title": "Hello", "size": { "width": 480, "height": 320 }, "minSize": { "width": 320, "height": 240 }, "resizable": true, "visible": true, "onClose": "hide" }, "type": "Window.Open" }
← { "id": 3, "payload": { "ok": {} }, "type": "Window.Open" }
→ { "id": 5, "payload": { "window": "settingsWindow", "path": "/settings", "title": "Settings", "size": { "width": 400, "height": 300 }, "resizable": false, "visible": false, "onClose": "hide" }, "type": "Window.Open" }
← { "id": 5, "payload": { "ok": {} }, "type": "Window.Open" }
→ { "id": 7, "payload": { "tray": "tray", "icon": "/home/me/hello-desktop/tray.png", "monochrome": true, "tooltip": "Hello", "menu": [{ "type": "item", "item": 0, "label": "Open Hello", "enabled": true }, { "type": "item", "item": 1, "label": "Settings", "enabled": true }, { "type": "item", "item": 2, "label": "Write status to log", "enabled": true }, { "type": "item", "item": 3, "label": "Hello 1.0", "enabled": false }, { "type": "separator" }, { "type": "item", "item": 5, "label": "Quit", "enabled": true }] }, "type": "Tray.Open" }
← { "id": 7, "payload": { "ok": { "available": true } }, "type": "Tray.Open" }
← { "id": 2, "payload": { "tray": "tray", "item": 1 }, "type": "Tray.ItemChosen" }
→ { "id": 9, "payload": { "window": "settingsWindow" }, "type": "Window.Show" }
← { "id": 9, "payload": { "ok": {} }, "type": "Window.Show" }
← { "id": 4, "payload": { "tray": "tray", "item": 5 }, "type": "Tray.ItemChosen" }
→ { "id": 11, "payload": {}, "type": "Host.Quit" }
← { "id": 11, "payload": { "ok": {} }, "type": "Host.Quit" }
```

`Tray.ItemChosen` is a notification: the module dispatches the item's action, and a failure is logged without an answer to the host. `Tray.Open` answers `available: false` where the session has no tray, which is when the module logs `DESKTOP_TRAY_UNAVAILABLE`. Texts cross already translated into the language the module negotiated. On Windows the endpoint is a named pipe:

```
TELO_NEED_DESKTOP_HOST__ENDPOINT=npipe:////./pipe/telo-desktop-fixture
```

### The host-supplied listener

Between the kernel and `http-server`'s controller, in generation `telo-10`. A claim the host holds a socket for, and one it does not:

```
→ { "id": 3, "payload": { "port": 53817 }, "session": "k-1", "type": "Listener.Claim" }
← { "id": 3, "payload": { "ok": { "listener": "l-1", "address": "127.0.0.1" } }, "session": "k-1", "type": "Listener.Claim" }

→ { "id": 5, "payload": { "port": 9090 }, "session": "k-1", "type": "Listener.Claim" }
← { "id": 5, "payload": { "ok": { "listener": null } }, "session": "k-1", "type": "Listener.Claim" }
```

An admitted connection, whose inbound channel starts with the request the host already read:

```
← { "id": 8, "payload": { "listener": "l-1", "inbound": "c-12", "outbound": "c-13", "peer": "127.0.0.1:53901" }, "session": "k-1", "type": "Listener.Accept" }
← { "id": 10, "payload": { "channelId": "c-12", "credit": 0, "encoding": "bytes", "purpose": "connection" }, "session": "k-1", "type": "Channel.Open" }
→ { "id": 7, "payload": { "channelId": "c-13", "credit": 0, "encoding": "bytes", "purpose": "connection" }, "session": "k-1", "type": "Channel.Open" }
```

The first `Channel.Data` on `c-12` carries `GET / HTTP/1.1` with its `Host` and `Cookie` headers, exactly as the host read them. At teardown:

```
→ { "id": 9, "payload": { "listener": "l-1" }, "session": "k-1", "type": "Listener.Release" }
```

### External sign-in

`examples/notes-desktop/telo.yaml` wraps `notes-web`, a web app that signs users in through an OIDC provider and receives the answer at `/auth/callback`, with `icon.png` beside it:

```yaml
kind: Telo.Application
metadata: { name: NotesDesktop, version: 1.0.0 }
lang: en
requires: { telo: ">=0.130.0" }
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
