# telo-desktop-host

The webview helper `telo run` drives as the desktop host. It owns the native windows and tray icons of a desktop application (`wry` / `tao` / `tray-icon`) and is driven over a framed link on its **stdin and stdout**. It is the Rust half of the desktop host; the Node end of the link is a client in the CLI, written from this file.

It carries the CLI's version and is published with every release as `telo-desktop-host-<version>-<os>-<arch>[-<libc>]`, listed in the release's `checksums.txt`. It is **not** a Node twin: like `telorun-abi`, it has none, and `scripts/version-line.mjs` moves its `Cargo.toml` and `Cargo.lock` entry with the CLI's because it lies beneath `cli/rust/`. The link's message set is internal to one release — no compatibility across releases is kept, and the host refuses a helper whose `Helper.Ready.version` is not its own.

## The `gui` feature

The native toolkit (WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows) is behind the cargo feature `gui`, which is **not** a default feature. Without it the crate has no native dependency: the link, the frames, the message set, the two-origin decision, the data-store identifier, the menu model and the window / tray state machine are plain Rust in the library, tested by `cargo test -p telo-desktop-host`, and `cargo check --workspace` needs no WebKitGTK.

A build without `gui` still produces a `telo-desktop-host` binary: it writes `Helper.Unavailable` to its stdout and exits 1, so a host that obtained one refuses cleanly. **A release binary is always built `--features gui`.**

```
cargo build --release --locked -p telo-desktop-host --features gui
```

Linux needs the development libraries first (Debian / Ubuntu): `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev libdbus-1-dev pkg-config`. macOS builds with `MACOSX_DEPLOYMENT_TARGET=14.0`: the per-application WebKit data store the helper relies on exists from macOS 14. Windows needs the WebView2 runtime at run time, not at build time. On Windows the `gui` binary is GUI-subsystem (no console window); its link is pipes, which it inherits.

## Starting it

`telo-desktop-host` takes no arguments but `--version` (prints `telo-desktop-host <version>`). Spawn it with all three standard streams piped:

- **stdin / stdout** carry frames, both directions. Nothing else may write to them.
- **stderr** is free-form logs, for the host to forward or discard.
- The working directory and the environment are not read, except `WAYLAND_DISPLAY` / `DISPLAY` and the session bus (`DBUS_SESSION_BUS_ADDRESS`) on Linux.

The helper sends `Helper.Ready` (or `Helper.Unavailable`) first, without waiting for a request. The host then sends `Helper.Init` and nothing else before its response. Closing the helper's stdin makes it exit promptly (code 3); `Helper.Quit` makes it close everything and exit 0.

| Exit code | Meaning |
|---|---|
| 0 | `Helper.Quit` was served |
| 1 | unavailable: `Helper.Unavailable` was sent (or the build has no `gui`) |
| 2 | the host broke the protocol (a refused frame, envelope or payload) |
| 3 | the link closed, or a response could not be written, without `Helper.Quit` |

A helper that exits on its own with no `Helper.Quit` having been sent (the user chose Quit from the macOS menu, the OS is quitting) writes `Helper.QuitRequested` first where the toolkit allows it; the host treats the link ending as a graceful stop in either case.

## The link

**Frames** are the controller protocol's framed carrier byte for byte (`kernel/specs/controller-protocol.md` §3.1): `length` u32 big-endian, `class` u8, `metaLength` u32 big-endian, `meta` (UTF-8), `data`. Every frame on this link is a message frame (`class` `0x01`, empty `data`); a data frame is a violation. `length` over 16 MiB (16777216) is refused from the prefix before the body is read, and so is one under 5.

**The meta** is the typed-frame JSON envelope of exactly three members, written canonically (members ordered by key): `id`, `type`, `payload`. `id` is a whole, non-negative number below 2^53. The helper reads any member order and any JSON spelling of a whole number (`3`, `3.0`).

- **Requests** flow host to helper, with **odd** ids minted by the host, and are answered by a frame carrying the request's `id` and `type` and a payload `{ "ok": <body> }` or `{ "error": { "code", "message" } }`.
- **Notifications** flow helper to host, with **even** ids minted by the helper (2, 4, …), and are never answered. The host sends none.
- The helper sends no requests, so any response or notification the host sends is a violation.

A frame the helper refuses — a bad length, a data frame, a meta that is not an envelope, an even request id, an unknown `type`, a payload its table rejects (a missing member, a wrong type, **a member the table does not list**) — is **terminal**: it logs the reason to stderr and exits 2. It sends no response.

Numbers in payloads are JSON numbers; a count or index is a whole number, a size a finite number above 0.

## Messages

### Helper to host (notifications)

| Type | Payload | When |
|---|---|---|
| `Helper.Ready` | `{ version, tray }` | first frame, once. `version` is the helper's own; `tray` is whether `Tray.Open` can show an icon: always `true` on macOS and Windows, on Linux `true` only when the session bus has an owner of `org.kde.StatusNotifierWatcher` (stock GNOME has none; a bus that cannot be asked counts as none, logged to stderr). |
| `Helper.Unavailable` | `{ reason }` | instead of `Helper.Ready`, then exit 1: no display (`no display (neither WAYLAND_DISPLAY nor DISPLAY is set)`), the toolkit could not start, no usable webview runtime (WebView2 missing). |
| `Helper.QuitRequested` | `{}` | the loop ended without the host asking, on a quit the OS or the macOS menu started (best effort: the process is already ending). |
| `Helper.Reopened` | `{}` | macOS: the user clicked the Dock icon. Never sent elsewhere. |
| `Window.Closed` | `{ window }` | the user closed a window opened with `onClose: "close"`; the helper has destroyed it. A hidden window (`onClose: "hide"`) sends `Window.Hidden` instead, and a close the host asked for (`Window.Close`) is not reported. |
| `Window.Hidden` | `{ window }` | the user closed a window opened with `onClose: "hide"`; the helper has hidden it and still holds it. Not sent for a `Window.Hide` request. |
| `Window.OpenRequested` | `{ fromWindow, url }` | a `window.open` / `target=_blank` / `rel=noopener` link on `origin`: cancelled in the webview, the host decides whether another window opens. |
| `Navigation.External` | `{ window, url }` | a navigation, link, form post or `window.open` on neither `origin` nor `hostOrigin`: blocked in the webview — it never loads in a window — and reported; the host opens the system browser. |
| `Tray.ItemChosen` | `{ tray, item }` | a menu item of an open tray icon was chosen; `item` is its index in the whole menu. |
| `Tray.Clicked` | `{ tray }` | Windows only: a primary click on the icon (which does not open the menu there). |

### Host to helper (requests)

Every request is answered `{ ok: {} }` unless the table says otherwise. A request naming a `window` or `tray` that is not held is `ERR_DESKTOP_HOST_UNKNOWN_ENTRY` (the two closes excepted); one the toolkit cannot carry out is `ERR_DESKTOP_HOST_REQUEST_FAILED` with the reason in `message`.

| Type | Payload | Meaning |
|---|---|---|
| `Helper.Init` | `{ identifier, productName, origin, hostOrigin, webviewDirectory, showInDock, icon? }` | The first request; once. `origin` is the application's origin, `http://127.0.0.1:<port>`, and `hostOrigin` the host's own pages, `http://127.0.0.1:<another port>` (each scheme, host and optional port only; `http` or `https`; the two must differ). `webviewDirectory` is an absolute path, created if missing: the webview's data store on Windows and Linux; macOS ignores it. `showInDock: false` makes the macOS app an accessory (no Dock icon, no app switcher entry). `icon` is the absolute path of a PNG, used as the window icon on Windows and Linux. |
| `Window.Open` | `{ window, url, title?, size?, minSize?, resizable, visible, onClose }` | Creates a window and loads `url`, which the host built (`<hostOrigin>/admit?code=<code>`); the helper loads it as is. `url` must be on `origin` or `hostOrigin`. `window` is unique among open windows. `title` defaults to `productName`. `size` and `minSize` are `{ width, height }` in logical pixels. `visible: false` creates it hidden. `onClose` is `"close"` (the user's close destroys it, `Window.Closed` follows) or `"hide"` (the user's close hides it). |
| `Window.Show` | `{ window }` | Shows the window, un-minimizes and focuses it. |
| `Window.Hide` | `{ window }` | Hides it; it stays held. |
| `Window.Focus` | `{ window }` | Focuses it without changing whether it is shown; a hidden window stays hidden. |
| `Window.Navigate` | `{ window, url }` | Loads `url` in the window; `url` must be on `origin` or `hostOrigin`. |
| `Window.Close` | `{ window }` | Destroys the window. Closing one already closed, or never opened, is `ok`; no `Window.Closed` follows. |
| `Tray.Open` | `{ tray, icon, monochrome, tooltip?, menu }` → `{ available }` | Shows a tray icon. `icon` is an absolute PNG path. `monochrome: true` is a macOS template image (ignored elsewhere). `menu` is a list of `{ type: "item", item, label, enabled }` and `{ type: "separator" }`; `item` must equal the entry's index in the whole list, separators counted. With `Helper.Ready.tray: false` it answers `{ available: false }` and shows nothing; the tray is not held and no `Tray.ItemChosen` / `Tray.Clicked` ever arrives for it. The tooltip is not shown on Linux (the toolkit has none). |
| `Tray.Close` | `{ tray }` | Removes it. Closing one not held, or unavailable, is `ok`. |
| `Helper.Quit` | `{}` | Closes every window and tray icon, answers `ok`, then exits 0. |

### Error codes

| Code | Meaning |
|---|---|
| `ERR_DESKTOP_HOST_UNKNOWN_ENTRY` | `Window.Show` / `Hide` / `Focus` / `Navigate` of a window not held |
| `ERR_DESKTOP_HOST_REQUEST_FAILED` | the toolkit refused (a window or webview could not be created, an icon is not a usable PNG), a duplicate `window` / `tray` name, or a `url` on neither origin. A refusal names the window, never the URL, which can carry a single-use code. |
| `ERR_DESKTOP_HELPER_NOT_INITIALIZED` | a window or tray request before `Helper.Init` was served |
| `ERR_DESKTOP_HELPER_ALREADY_INITIALIZED` | a second `Helper.Init` |

## What the helper decides

**Which origin.** From `origin` and `hostOrigin` in `Helper.Init`: a URL is on one when scheme, host and port all match it (the default port stands for an omitted one; the scheme and host compare case-insensitively; leading zeros in a port are the same number). `about:blank` is allowed, and `blob:` of either origin. Everything else is external, and the reading is conservative: a URL not read as `scheme://authority…`, an authority with userinfo (`http://127.0.0.1:1@evil.com`), a host with a trailing dot, a port that is not digits, and a URL with a `\` ending the authority before the real host are all external. A leading or trailing space and tabs or newlines inside the URL are dropped, as a URL parser drops them.

**Navigation.** Every navigation of a window — typed, a link, a redirect, a form post, a script — asks the same question before it loads. Either origin loads: a window's admission and the host's pages are on `hostOrigin`, the application on `origin`. External does not load: the helper cancels it and sends `Navigation.External`. A new-window request (`window.open`, `target=_blank`) is always cancelled: on `origin` it sends `Window.OpenRequested`, external sends `Navigation.External`, one on `hostOrigin` sends nothing and is logged to stderr without its URL (the host's pages are reached only through URLs the host gave a window), and a bare `about:blank` one sends nothing — which is why a popup that relies on `window.opener` is unsupported. The toolkit does not tell a top-level navigation from an iframe's, so an embedded external frame is reported (and blocked) too.

**The data store.** Every window opens in a store of the application's own, never the shared default. macOS: a WebKit data store whose identifier is the UUIDv5 of `identifier` under the namespace `5f3c1d9a-7b24-4e68-a1c5-3d8e9f0b2c47` (fixed forever; for `run.telo.examples.hello` it is `667803e2-a901-5181-80c5-87bb14bd5e78`). Windows and Linux: a web context over `webviewDirectory`.

**Held windows and trays.** The state machine is `src/helper.rs`; the toolkit sits behind its `Backend` trait. A window the user closed with `onClose: "close"` is forgotten, so a later `Window.Show` of it is `ERR_DESKTOP_HOST_UNKNOWN_ENTRY`.

**macOS menu bar.** The helper installs an application menu (hide, quit), an Edit menu (undo, redo, cut, copy, paste, select all) and a Window menu, because a webview cannot copy or paste without them and Cmd-Q needs a Quit item.

## Layout

The library mirrors no Node file; the header of each file says why. `frame.rs` (the carrier), `envelope.rs` (the meta), `payload.rs` (closed-object reading), `messages.rs` (the message set), `menu.rs`, `origin.rs`, `navigation.rs`, `store.rs`, `icon.rs` (PNG to RGBA), `helper.rs` (the state machine and the `Backend` seam), `link.rs` (writer, reader, dispatch). `gui.rs` and `gui/` (feature `gui`) are the toolkit wiring.

## Tests and what is not covered

`cargo test -p telo-desktop-host` (no feature) covers the frame codec (round trip, oversized and short lengths refused before the body is read), the envelope, every payload's validation, the UUIDv5 value, the two-origin decision table, the menu model and the window / tray state machine over a fake backend, and the dispatch over an in-memory link.

The `gui` layer is type-checked, never linked or run: `cargo check --features gui` passed on Linux (against a stub `pkg-config`), `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`, but no window, webview or tray icon has been created by it. Until it has run on each platform, the behaviours that live only there are unverified: the toolkit's navigation and new-window callbacks (including how each engine handles the two origins), the per-window data store, hiding and showing, the Dock `Reopen` event, the macOS menu bar, and the Linux tray.
