# Desktop-host protocol — generation `desktop_host-1`

Normative for the control channel between `modules/desktop` (the **module end**) and a desktop host (the **host end**): the process that owns the native windows and tray icons. The module end is the application; the host end is whatever supplies a `Telo.DesktopHost` need — `telo run` as the desktop host, another shell embedding Telo, or a test fixture. The module speaks only this protocol and cannot tell them apart.

## 1. The carrier

One connection serves one fulfilment of the need and is shared by every resource of one application that names it. The module end dials the need's `endpoint` field: a `unix:` URL names a Unix domain socket by its path, an `npipe:` URL a Windows named pipe (`npipe:////./pipe/<name>`). It is a byte stream, and it carries **frames of the controller protocol's framed carrier, byte for byte** (`controller-protocol.md` §3.1): `length` u32 big-endian, `class` u8, `metaLength` u32 big-endian, `meta`, `data`, with `MAX_FRAME_LENGTH` 16 MiB refused from the length prefix before the body is read. Every frame here is a message frame (`class` `0x01`, empty `data`); a data frame is a protocol violation. `@telorun/sdk` exports the codec (`encodeFrame`, `decodeFrame`, `FrameReader`).

The `meta` is the typed-frame JSON (`durable-execution.md` §6) of an **envelope with exactly three members**, in the typed frame's canonical key order:

- `id` — a whole, non-negative number. The module end mints **odd** ids, the host end **even** ones, unique per connection; an id is not reused while a request bearing it is outstanding.
- `type` — the message name.
- `payload` — the message body. On a response it is `{ "ok": <body> }` or `{ "error": { "code", "message" } }`.

There is no `session`: the connection is the session. A message whose table below gives a response is a **request**; the response carries the request's `id` and `type`. A message with no response is a **notification**, and no response is ever sent for it. Requests and notifications of both ends interleave freely; neither end blocks reading on a handler.

A frame either end refuses — a length over the bound, a meta that is not a typed-frame envelope of the three members, an unknown `type`, a payload its table rejects, a response answering no outstanding request — is **terminal**: the refusing end closes the connection and resynchronises nothing. The module end then fails every call in flight and every later one with `ERR_DESKTOP_HOST_PROTOCOL_VIOLATION`.

## 2. Handshake

The first message on a connection is the module end's `Host.Hello` request carrying `generation` (`desktop_host-1`) and the need's `token`. The host checks the token first: a wrong one is answered with an `error` response, code `ERR_DESKTOP_HOST_TOKEN_INVALID`, and the host closes the connection. Otherwise it answers `ok` with **its own** `generation`, never negotiating down. The module end refuses a generation other than its own with `ERR_DESKTOP_HOST_INCOMPATIBLE`, naming both, and closes the connection. A host serves no other message before a successful `Host.Hello`, and the token appears in no other message. A host that accepted the connection and has not answered `Host.Hello` within **5 seconds** is treated as unreachable: the module end closes the connection and refuses with `ERR_DESKTOP_HOST_UNREACHABLE`, naming the endpoint and that the host never answered.

## 2.1 Ending

A connection ends expectedly when the module end closes it or the host closes it after a `Host.Quit` the module sent; nothing is reported, and what the connection held (windows, tray icons) stops holding the application. Any other end — a peer that closes or resets the connection unasked, a refused frame (`ERR_DESKTOP_HOST_PROTOCOL_VIOLATION`) — is an **error**: the module end logs it once per connection at error severity, naming the code, the endpoint and the reason, and the application exits with a non-zero code.

## 3. Messages

Payloads are the request body; `ok` is the response body. Texts (`title`, `tooltip`, `label`) cross already translated and formatted: plain strings, in the application's fallback language.

| Type | From | Request | `ok` |
|---|---|---|---|
| `Host.Hello` | module | `{ generation, token }` | `{ generation }` |
| `Host.Quit` | module | `{}` | `{}` — the host's graceful stop, as SIGTERM |
| `Window.Open` | module | `{ window, path, title?, size?, minSize?, resizable, visible, onClose }` | `{}` |
| `Window.Show` | module | `{ window }` | `{}` — shows and focuses it |
| `Window.Close` | module | `{ window }` | `{}` — destroys it; closing one already closed is `ok` |
| `Tray.Open` | module | `{ tray, icon, monochrome, tooltip?, menu }` | `{ available }` |
| `Tray.Close` | module | `{ tray }` | `{}` |
| `Window.Closed` | host | `{ window }` | notification |
| `Tray.ItemChosen` | host | `{ tray, item }` | notification |
| `Tray.Clicked` | host | `{ tray }` | notification |

- `window` and `tray` are the opening resource's name, unique among the module's resources of that kind. `path` is app-relative, starting with `/`; `size` and `minSize` are `{ width, height }` in logical pixels; `onClose` is `close` or `hide`.
- `icon` is the absolute path of a PNG file. `menu` is a list of `{ type: "item", item, label, enabled }` and `{ type: "separator" }`; `item` is the entry's index in the whole list (separators counted), and is what `Tray.ItemChosen` returns.
- `Tray.Open` answers `available: false` where the session has no tray: nothing is shown, the tray does not count as open, and later `Tray.ItemChosen` and `Tray.Clicked` for it never arrive. `Tray.Close` of an unavailable tray is `ok`.
- `Window.Closed` says the user closed a window declared `onClose: close`; the host has destroyed it. A hidden window sends nothing to the module.
- `Tray.Clicked` is a primary click on the icon where the platform separates it from opening the menu (Windows).
- A request naming a `window` or `tray` the host does not hold (other than the closes above) is answered `ERR_DESKTOP_HOST_UNKNOWN_ENTRY`; a request the host cannot carry out, `ERR_DESKTOP_HOST_REQUEST_FAILED`, with the reason in `message`.

## 4. Error codes

| Code | Raised by | Meaning |
|---|---|---|
| `ERR_DESKTOP_HOST_TOKEN_INVALID` | host, then module | the token does not match the host's |
| `ERR_DESKTOP_HOST_INCOMPATIBLE` | module | the host answers another generation |
| `ERR_DESKTOP_HOST_UNREACHABLE` | module | the endpoint could not be dialed, the host never answered `Host.Hello`, or the connection closed |
| `ERR_DESKTOP_HOST_PROTOCOL_VIOLATION` | module | a refused frame (§1) |
| `ERR_DESKTOP_HOST_UNKNOWN_ENTRY` | host | a window or tray the host does not hold |
| `ERR_DESKTOP_HOST_REQUEST_FAILED` | host | a request the host cannot carry out |

## 5. `telo run` as the desktop host

Everything in this section is the host `telo run` implements; none of it is part of the protocol above. A host supplied through the environment carries the control channel only: under it `telo run` starts no helper, takes no lock, binds no port and admits nothing. The window and tray calls `telo run` makes of its helper (`Window.Hide`, `Window.Focus`, `Window.Navigate`) and what the helper reports (`Window.Hidden`, `Window.OpenRequested`, `Navigation.External`, `Helper.Reopened`) are the helper link's own messages, written in `cli/rust/desktop-host/README.md`; this section uses their names.

### 5.1 When `telo run` is the host

`telo run` is the desktop host when the root Application declares a `Telo.DesktopHost` need and the environment — the env files included — sets neither of its fields (`TELO_NEED_<NEED>__ENDPOINT`, `TELO_NEED_<NEED>__TOKEN`, or the names its `env:` binds). Then, before the kernel is built and anything initializes, in this order:

1. the machine is checked (`ERR_DESKTOP_HOST_UNAVAILABLE`: no display, macOS older than 14);
2. the single-instance lock of the need's `identifier` is taken (§5.2); a second start ends here;
3. the two origins are bound (§5.3);
4. the helper `telo-desktop-host` is located and started (`ERR_DESKTOP_HOST_UNAVAILABLE` for every way that fails);
5. the control channel is opened (§5.4).

The kernel is then handed the app origin's socket as the host-supplied listener of that port number, the port number for the root's `ports:` entry the need names, and the need's `endpoint` and `token`, all supplied by name — so the port's environment variable needs no value, `Kernel.PortsResolved` reports it as `{ "port": <n>, "protocol": "tcp", "address": "127.0.0.1", "suppliedBy": "host" }`, and neither field is ever in the environment a controller reads. A failure in any step exits 1 with its diagnostic; the lock is released and the sockets removed on every exit path. `telo run --watch` is refused with `ERR_DESKTOP_HOST_UNAVAILABLE` where it would be the host.

### 5.2 Single instance

The lock is a local socket in the per-user application directory — `$XDG_DATA_HOME/<identifier>` (else `~/.local/share/<identifier>`), `~/Library/Application Support/<identifier>`, `%LOCALAPPDATA%\<identifier>` — at `desktop-host/instance.sock`; where that path would exceed 103 bytes, `telo-desktop-<uid>/<first 16 hex digits of the identifier's SHA-256>.sock` under the first of `$XDG_RUNTIME_DIR` and the temporary directory where that path fits, a `0700` directory; on Windows the named pipe `\\.\pipe\telo-desktop-<same digits>`. A start that can listen on it holds the lock. A socket file nothing answers is left by a crashed instance and is replaced.

A start that finds the lock answered is a **second start**. It sends one JSON line `{"type":"show"}`; the holder shows its windows (§5.6) and answers one line `{"pid":<process id>,"source":"<the manifest or packaged executable it runs>"}` and closes. The second start prints `<productName> is already running (process <pid>, <source>); its windows are shown` on stdout and exits 0, having started nothing.

Everything under `desktop-host/` — the lock, `port`, the helper's `webview/` store — is read and written only by the lock's holder.

### 5.3 The origins

A window loads two origins, each a socket listening on `127.0.0.1` only.

- The **app origin**, `http://127.0.0.1:<port>`, is the application's, on a port that stays the same across launches so browser storage keyed by the origin does too. The port is the `default:` of the root's `ports:` entry the need names when it declares one; otherwise the number recorded in `desktop-host/port`, OS-assigned and recorded on the first start. When that port cannot be bound, or the file holds no port, a new OS-assigned port is recorded and a `DESKTOP_ORIGIN_CHANGED` warning names both origins. No file is a first start and warns nothing.
- The **host origin**, `http://127.0.0.1:<host port>`, serves every page the host itself shows in a window (§5.5, §5.8, §5.9), on a port the OS assigns at every start. It is recorded nowhere, never handed to the kernel and not reported on `Kernel.PortsResolved`.

A cookie ignores the port, so the admission cookie (§5.5) is sent to both origins.

### 5.4 The control channel

On Unix the channel is the socket `control.sock` in a fresh directory created `0700` under `$XDG_RUNTIME_DIR` (else the temporary directory), its `endpoint` `unix://<path>`; on Windows the named pipe `\\.\pipe\telo-desktop-<random>`, its `endpoint` `npipe:////./pipe/telo-desktop-<random>`. The `token` is fresh for every start. The host answers `Host.Hello` per §2, mints even ids, and refuses frames per §1. `Window.Open` creates the window, whose first load is its admission on the host origin, sending it on to `<app origin><path>` (§5.5); `Host.Quit` is answered and then the host takes its graceful stop (§5.7). A connection that ends closes the windows and tray icons it opened.

### 5.5 Admission

**The host never answers a request on a connection it handed to the kernel, and every page the host shows in a window is served on the host origin.** A webview pools keep-alive connections across every window of its data store and the application's server keeps an idle connection open, so any later request on an admitted connection — whatever it asks for — is the application's.

On both origins the head of a request is read up to 16 KiB and for at most 10 seconds; a longer one is refused, a slower one dropped. The **admission secret** is a random value fresh for every start, distinct from the `token`.

**The app origin** admits each connection on its first request, before the kernel sees it:

- `Host` must be exactly `127.0.0.1:<port>`.
- A request carrying the `telo-window` cookie equal to the admission secret, whose `Origin` is absent, the app origin or the host origin (the sign-in form of §5.9 is submitted from the host origin), is handed to the kernel's listener whole, with the bytes already read; the host reads nothing more of that connection.
- An armed external sign-in return (§5.9) is answered by the host, with `Connection: close`. It never holds the cookie, so it is always the first request of a connection of its own.
- Everything else — a missing or wrong cookie, a forged `Host` or `Origin`, a malformed head — is answered `403 Forbidden` with `Connection: close`, and closed.

The application owns every path of the app origin: the host serves no page there and reads no query parameter.

**The host origin** reads every request itself and answers each with `Connection: close`. `Host` must be exactly `127.0.0.1:<host port>`, and `Origin` absent or the host origin.

- For each window it opens, the host issues a single-use code bound to that window and to a destination: the window's path and query on the app origin, or `<host origin>/startup` for the startup window (§5.8). The window's first URL is `<host origin>/admit?code=<code>`. A `GET` of it carrying a code the host issued and nobody used is answered `303 See Other`, `Location` the destination as an absolute URL built from its origin — never from the request, so no path makes a redirect leave the origins — `Set-Cookie: telo-window=<admission secret>; HttpOnly; SameSite=Strict; Path=/`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. A code is revoked when its window closes.
- `GET /startup`, `POST /startup/answers` (§5.8) and `GET /return` (§5.9) must carry the cookie.
- Everything else — an unknown or used code, a missing or wrong cookie, a forged `Host` or `Origin`, a path the host serves no page at — is answered `403 Forbidden`.

Neither secret appears in argv, a URL or the manifest's scope, and both join the root's redaction set. A connection admitted on the app origin while no server can take it — a window opened before the application's server is up — is answered `503` with the host's page: the startup view while it starts, the boot-refusal view once startup failed (§5.8).

### 5.6 Windows

Every window is opened in the application's own webview data store. Without a tray (the session has none: `Tray.Open` is answered `available: false`), every window is opened shown, `visible: false` ones included, so the application stays reachable.

A second start, and on macOS a click on the Dock icon, shows again every window the application opened declared `visible: true`, and every one declared `visible: false` while no tray icon is open; it focuses the first of them opened. Any other window is left as it is — one declared `visible: false` that a tray item showed and the user hid stays hidden while the tray icon is open.

A `window.open` on the app origin opens another window, admitted with a code of its own, shown, closed when the user closes it; one on the host origin opens nothing and is logged. A navigation to either origin loads in the window. A navigation to any other origin is not loaded: an `http` or `https` one opens in the system browser, anything else is refused and logged.

### 5.7 Shutdown

The host's graceful stop is the stop SIGTERM takes: on `Host.Quit`, when the OS or the macOS menu quits the helper, and — once some window has been shown or a tray icon open — when the user closes a window — or hides one declared `onClose: hide` — and that leaves no window visible and no tray icon open. The host's own startup window (§5.8) never counts. An application that has shown neither keeps running. A helper that ends unasked stops the application the same way, logs the cause at error severity, and the exit status is 1. However the application ends, its windows and tray icons are closed and the helper quits; the exit status is otherwise the application's.

### 5.8 The startup window and the host's pages

As soon as the helper is up, before the kernel loads, the host opens one window of its own, `telo.startup`, titled `productName`, admitted like any window and sent on to `<host origin>/startup`. It shows the **startup view** (the product name and "Starting…", reloading itself every second). It is never reported to the application, never counts toward "nothing is visible", and is not shown again by a second start.

**Pages.** On the host origin, with the cookie: `GET /startup` renders the current state, `POST /startup/answers` takes the inputs form and answers `303` to `/startup`. Once startup ended (`Kernel.Started`) both are `404 Not Found`.

**State.** The window shows the startup view; the inputs form while the load asks for inputs nothing supplies; the **boot-refusal view** once startup failed — the diagnostics `telo run` prints, as text. The `503` of an admitted connection no server takes is the startup view (while starting) or the boot-refusal view (after a failure).

**Missing inputs.** Where `telo run` would ask at a terminal, the host asks in one form in the startup window, each input by its declaration: its environment variable, title or description, type (text, a `select` for an `enum` or a boolean, a masked field for a secret or sensitive field, a text area for JSON), the constraints the terminal asker lists, and the kernel's refusal of the previous answer. Answers are text, decoded exactly like an environment value and never written to the environment; a refused one re-renders the form with the non-sensitive values kept and a new token. The form carries a single-use token (the admission cookie and `Origin` check already gate the request); a submission with any other token changes nothing. Closing the window while the form waits declines the inputs, so the load fails with the missing-values refusal. `--no-input` asks nothing and refuses as it always has, without waiting for the window. Nothing offers to save the answers.

**Boot refusal.** A failure that makes `telo run` print diagnostics and exit 1 still prints them, and also shows them in the window; the exit (status 1) comes when the user closes the window, the helper ends, or the process is told to stop. A refusal that happens before the window exists exits at once.

**Closing.** The startup window closes as soon as the application has opened its first visible window — after that window is shown, so there is never a moment with none — or, when startup ends and it opened none, at the end of startup. A user closing it while the application is still starting asks the host to stop.

### 5.9 External sign-in

A sign-in that leaves for an external identity provider returns through the app origin, so the web app's own redirect address, built from its origin, works unchanged.

**The armed return.** The host holds at most one. Each navigation a window sends to the system browser (`Navigation.External`, and a `window.open` to another http(s) origin) arms it, recording that window; a later one replaces it. It is cleared when that window is closed — hiding a window does not clear it. Nothing arms it when the need declares no `callbackPaths`.

**The return.** A request to the app origin that is not admitted by the cookie — it carries none, or a foreign `Origin` — whose `Host` is the app origin's and whose path is exactly one of the need's `callbackPaths` is the return while one is armed. The path is compared as written in the request line, case-sensitively, with nothing normalized: `//auth/callback`, `/auth/./callback`, `/auth%2Fcallback`, a trailing slash or a different case is not the declared path. `Host` is checked as for any request; `Origin` is not: a provider answering with `form_post` sends the POST from its own origin, so a foreign `Origin` is expected on this one request, and the armed return, the declared path and the `Host` check are what admit it. A return of another method than `GET` or `POST`, a `POST` that is not `application/x-www-form-urlencoded` (parameters after the type allowed), that states no single `Content-Length` or states one over 64 KiB, and any request while nothing is armed or to another path are `403` with `Connection: close`, and leave an armed return armed. The first accepted return uses it up — before its body is read, so no second one can take it.

**The host's answer.** The host does not serve the return to the browser. It answers `200`, `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, with the body `<p>Return to <productName> to finish signing in.</p>` (`productName` HTML-escaped); focuses the window that armed the return (`Window.Focus`); and replays the request there with `Window.Navigate`:

- a `GET` to `<app origin><path>?<query>` as received, which the window loads with its cookie;
- a form `POST` to `<host origin>/return?code=<code>`. The code is 18 random bytes, base64url, bound to the window, the path and the form's fields in order, duplicates kept, valid for two minutes and revoked when the window closes. The host answers a `GET /return` carrying the cookie and exactly one `code` holding a live code: `200`, `text/html`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a `<form method="post" action="<app origin><path>">` with a hidden `<input>` per field (name and value HTML-escaped, in the order received) and a script that submits it at once. The code is used up when served; a second use, an unknown or expired code, or a request without the cookie is `403`. The submission carries the cookie and the host origin as `Origin`, which the app origin admits (§5.5), so it reaches the application on whichever connection the webview uses, whatever the window showed before.

No field is logged or given to the helper; the code reaches the helper only inside the `Window.Navigate` URL, and the host logs `desktop.signin.return_used`, with no value, when it replays a return.

**What stays the web app's.** The host cannot tell a genuine provider return from a forged one: the protection is the web app's own `state` / PKCE check. A web app that allowlists the `Origin` of its callback `POST` must accept the host origin, whose port changes every start, as a `form_post` callback already must accept the provider's. A popup flow that relies on `window.opener` is not supported: a navigation to another origin opens the system browser, which has no opener. A provider that accepts any loopback port (RFC 8252 §7.3) needs nothing more; one that matches the redirect address exactly needs the port's `default:` on the root, since the origin is then the same every launch.
