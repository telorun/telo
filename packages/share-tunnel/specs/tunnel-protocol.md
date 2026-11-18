# The share tunnel protocol — generation 1

**Status: normative.** A shared run (`telo run --share`) keeps one tunnel open to its runner's relay, and every visitor request for the share's public addresses reaches the run through it. The **client** is the CLI, whose engine is `@telorun/share-tunnel`; the **relay** is the runner that serves the tunnel endpoint. Both run the vectors in [`vectors/`](./vectors/); a behaviour the vectors pin and this text contradicts is a defect in this text.

The client and the relay agree on the **generation** and nothing else. A change to any message, field, close code or number below is a new generation, named by a new subprotocol.

How a share is taken (`POST /v1/shares`, which answers its `tunnelUrl`) is the runner `/v1` contract's, `@telorun/runner-protocol`.

## 1. The endpoint

The tunnel is a WebSocket (RFC 6455) at the share's `tunnelUrl`, `wss://tunnel.<base domain>/v1/shares/<id>/tunnel`.

- The client offers the subprotocol of every generation it speaks; generation 1 is **`telo-share-1`**. The relay selects one.
- **No extension is negotiated.** A frame's payload length is its message's length.
- The upgrade carries `Authorization: DPoP <access token>` and a `DPoP` proof (RFC 9449) with `htm` `GET` and `htu` the `https://` form of `tunnelUrl` (`wss` read as `https`). A proof is fresh per upgrade. The relay verifies both as the runner verifies `/v1` (the token's `aud` holds the runner's audience; the proof's `jti` is recorded and a replay is refused), against the URL it was reached at.
- The relay accepts the upgrade and then answers a refusal with a close code (§ 8), so the client can read why. A refusal by anything between the two (an edge answering `502`) is an HTTP status the client retries through.

**Mismatch.** An upgrade where the relay selects none of the offered subprotocols is terminal for the client: retrying cannot change the answer. So is a close `4400` (§ 8).

## 2. The channel

- A **text message** is one control message: a JSON object with a string `type` (§ 3). Every control message is closed: an unknown `type`, or a field the message does not define, is a protocol error.
- A **binary message** is bytes of one HTTP/2 connection (§ 5): an ordered byte stream whose message boundaries mean nothing.
- A text message is at most **64 KiB** (65 536 bytes of UTF-8), a binary message at most **1 MiB** (1 048 576 bytes). The size is judged before the content.

The order is fixed:

1. the client sends `hello`;
2. the relay answers `hello`;
3. the relay sends the HTTP/2 client connection preface, and the client its server preface;
4. from then on binary messages flow both ways, and the client may send `ports` and `auth` at any time.

On each connect, when the client holds a ports list, its first message after the relay's `hello` is `ports` (§ 6).

Either side closes the tunnel **`4400`** for:

- a binary message, or any control message other than `hello`, before the handshake completes — for the relay, before the client's `hello`; for the client, before the relay's;
- a second `hello`;
- a message that is not JSON, not an object, or has no string `type`;
- an unknown `type` or field, or a field outside its range (§ 3);
- a text message over 64 KiB or a binary message over 1 MiB;
- a relay `hello` answering another epoch than the client presented (§ 4).

Control stays outside HTTP/2 because the fence (§ 4) must be settled before HTTP/2 starts, and because the client, as the HTTP/2 server, could not open a stream of its own.

## 3. Control messages

| Direction | Message | Fields |
|---|---|---|
| client → relay | `hello` | `epoch`: `null` on a run's first connect, else the epoch the relay last answered this run — a non-negative integer. |
| client → relay | `ports` | `ports`: a list of `{ name, port }` — `name` a non-empty string, unique in the list; `port` an integer from 1 to 65535. The list replaces the last whole. |
| client → relay | `auth` | `accessToken`, `proof`: non-empty strings — a renewed credential (§ 7). |
| relay → client | `hello` | `epoch`: the epoch this tunnel holds, a non-negative integer. |

An integer is a JSON number holding a safe integer (at most 2⁵³ − 1).

## 4. The fence

Each share holds an `epoch`. It says which run holds the share, so that a second run of the same share takes it over and the first cannot come back.

- `hello { epoch: null }`: the relay increments the share's epoch, takes the share's lease, and answers `hello` with the new epoch. The client keeps it in memory for the run.
- `hello { epoch: n }`: when `n` is the share's epoch, the relay takes the lease and answers `hello` with `n`. Any other `n` closes **`4409`**.
- A share that is unknown, deleted or another owner's closes **`4404`**, revealing nothing.
- No `hello` within **10 s** of the upgrade closes **`4408`**.
- A run that takes a share over makes the relay send the older tunnel an HTTP/2 GOAWAY and close it `4409` once its last stream ends, or 10 s after the GOAWAY. The older run's later reconnects present the old epoch and are closed `4409` too.

How the relay stores the epoch and the lease, and how it learns of a delete, is the runner's.

## 5. HTTP/2 inside

The binary messages carry one HTTP/2 connection (RFC 9113) with the **relay as the client** and the **client as the server**; the server enables extended CONNECT (`SETTINGS_ENABLE_CONNECT_PROTOCOL`, RFC 8441).

- **Requests.** Each visitor request is a stream. It carries the visitor's `Host` as `:authority` and the target port in the request header **`telo-share-port`** (decimal), which the relay sets, overwriting any a visitor sent. The relay passes the edge's `X-Forwarded-*` headers unchanged.
- **Local target.** The client forwards each stream to `127.0.0.1` on the target port, as HTTP/1.1, with `:authority` as `Host` and without `telo-share-port`. It answers **`404`** for a stream whose port its last `ports` message did not list, or whose `telo-share-port` is missing or not a port, and **`502`** when nothing answers on the port. A slow port is the relay's to time out.
- **Visitor WebSockets** arrive as extended CONNECT streams with `:protocol` `websocket`. The client makes each an HTTP/1.1 upgrade on the local port and answers `200` once the local server switches protocols, then carries the WebSocket's bytes both ways; a local refusal is answered with its own status. Any other CONNECT is answered `501`.
- **Backpressure** is HTTP/2 flow control: neither side buffers a body beyond the windows it grants.
- HTTP/2 PING is answered as RFC 9113 requires; neither side sends one to keep the tunnel alive (§ 7).
- An HTTP/2 connection error a side detects is a protocol error: it closes the tunnel `4400`. After a GOAWAY, the side that sent it closes the tunnel.

## 6. Ports

The client sends `ports` with the `tcp` ports of its application each time the application loads, and on each connect (§ 2). The relay routes a visitor host for the share when its port is in the last list; a host whose port is not is the relay's `404`. An empty list routes nothing.

## 7. Liveness and credentials

- **Keepalive.** The relay sends a WebSocket ping every **20 s**; the client's WebSocket answers with a pong. A side that has received nothing — data, ping or pong — for **45 s** closes the tunnel **`4408`**, or drops the socket when the peer is unreachable.
- **Re-authentication.** The client sends `auth { accessToken, proof }` at least **60 s** before the token it last presented expires. The proof has `htm` `GET` and `htu` the `https://` form of `tunnelUrl`. The relay verifies it as it verifies the upgrade. A token for another owner closes **`4401`**, and so does the expiry of the newest token the relay holds.

## 8. Close codes

| Code | Sent by | Meaning | The client |
|---|---|---|---|
| `4400` | either | A protocol error (§ 2). | Ends the run: the runner is unsupported. |
| `4401` | relay | The credential was refused, or the newest token expired. | Retries. |
| `4404` | relay | The share is deleted, unknown or another owner's. | Ends the run: the share is lost. |
| `4408` | either | No `hello` within 10 s, or 45 s of silence. | Retries. |
| `4409` | relay | Another run holds the share. | Ends the run: the share is lost. |
| `4429` | relay | The owner is at its connected-share limit. | Retries. |
| `4503` | relay | The runner is at its connected-share capacity. | Retries. |

Any other close, a dropped socket, and an upgrade that does not complete are retried.

**Reconnects.** The client reconnects with a capped, jittered backoff, asking for its credential again on every attempt and presenting a fresh proof. It warns once per distinct reason — the reason's class, its close code, and the relay's close text — until a connect completes; a completed connect resets both the backoff and the warnings.

## 9. Vectors

[`vectors/`](./vectors/) pins this generation in three files. An implementation runs the rows of its own role and ignores the others.

### `messages.json` — the codec

`client` holds the messages the client sends (judged by the relay), `relay` those the relay sends (judged by the client). Each has `valid` rows `{ name, message }` — the object reads as itself — and `invalid` rows `{ name, text }` — a text message whose receipt closes the tunnel `4400`.

### `channel.json` — exchanges

Each row is `{ name, judge, steps, share?, ports? }`. `judge` is the implementation under test, `relay` or `client`; the **driver** is the replaying harness, playing the other side over a real WebSocket with subprotocol `telo-share-1`.

- A **relay** row's `share` is the state before the exchange: `{ epoch }`, a share the driver's credential owns, or `null`, no such share for it. The driver connects to the share's tunnel URL with a credential the relay accepts.
- A **client** row's `ports` is the list the client holds when it connects (absent: none). The client connects to the driver, which selects `telo-share-1`.

Steps run in order:

| Step | The driver |
|---|---|
| `{ "send": <object> }` | sends the object's JSON as a text message. |
| `{ "sendText": <text>, "padTo"?: <n> }` | sends `text` as a text message, padded with trailing spaces to `n` UTF-8 bytes. |
| `{ "sendBinary": <n> }` | sends a binary message of `n` zero bytes. |
| `{ "expect": <object> }` | takes the judge's next message: a text message whose JSON equals the object. |
| `{ "expectBinary": true }` | takes the judge's next message, a binary one, and every binary message right after it. |
| `{ "expectOpen": true }` | pings and takes the pong with the tunnel open; binary messages meanwhile are taken, a text message fails the row. |
| `{ "expectClose": <code> }` | sees the judge close the tunnel with `code`; binary messages meanwhile are taken, a text message fails the row. |
| `{ "close": <code> }` | closes the tunnel with `code`. |
| `{ "reconnect": true }` | (client rows) waits for the client's next connection; the steps after it are on that one. |

A client that closes `4400` in a row ends its run as unsupported (§ 8).

### `closes.json` — what the client does on each close

Run against the client. `upgrades` rows `{ name, answer, outcome, … }` answer the client's upgrade with `answer`: `{ subprotocol }` (`null`: none selected) or `{ status }` (an HTTP answer). `closes` rows `{ name, code, after, outcome, … }` close the tunnel with `code` right after the upgrade (`after: "upgrade"`, before answering `hello`) or after the relay's `hello` (`after: "handshake"`). The `outcome`:

- `lost`, with `lost` `deleted` or `superseded`: the run ends and the client does not connect again;
- `runner-unsupported`, with `cause` `no-subprotocol` or `protocol-error`: the run ends, naming the offered generations (`offered`), and the client does not connect again;
- `retry`, with `warning`: the client warns with that reason and connects again. Closed the same way again before a connect completes (`after: "upgrade"`), it does not warn a second time.

The warning reasons are the client engine's: `credential-refused`, `owner-limit`, `runner-capacity`, `timed-out`, `unreachable`, `disconnected`.
