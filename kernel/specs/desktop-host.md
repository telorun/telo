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
- `Window.Closed` says the user closed a window declared `onClose: close`; the host has destroyed it. A hidden window sends nothing.
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

## 5. Admission and the helper

Admission of the page's connections, the webview helper and the single-instance lock are internal to the host `telo run` implements, and are specified with it. They are not part of this protocol: a host supplied through the environment carries the control channel only.
