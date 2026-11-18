# @telorun/share-tunnel

The tunnel a shared run (`telo run --share`) keeps open to its runner's relay, so that visitors reach the run's local ports at the share's public addresses. The package holds:

- **the protocol**, generation 1: [`specs/tunnel-protocol.md`](./specs/tunnel-protocol.md) is the normative specification, and [`specs/vectors/`](./specs/vectors/) the machine-readable vectors every client and every relay replays (the format is in the specification's § 9);
- **the client engine** the CLI runs: one WebSocket to the relay carrying one HTTP/2 connection, each visitor stream forwarded to `127.0.0.1` on the port the relay names;
- **the codec** both sides share: the control messages, the limits, the close codes and the client's reading of each.

How a share is taken — `POST /v1/shares`, answering the share's `tunnelUrl` and its public-URL templates — is the runner `/v1` contract, specified by `@telorun/runner-protocol`. The relay is the runner's.

## The engine

```ts
import { startShareTunnel } from "@telorun/share-tunnel";

const tunnel = startShareTunnel({
  tunnelUrl: share.tunnelUrl,
  runnerUrl: "https://runner.telo.run",
  credentials, // a RunnerCredentialProvider, below
  onEvent: (event) => report(event),
});
tunnel.setPorts([{ name: "http", port: 8080 }]); // on every load
const ending = await tunnel.ended;
```

`startShareTunnel` returns at once and connects in the background, so the application can boot while the tunnel comes up.

- **`setPorts(ports)`** replaces the announced `tcp` ports and sends them on the open tunnel; it never reconnects. Every reconnect announces the current list again. A visitor stream for a port outside the list is answered `404` and reaches nothing.
- **`close()`** closes the tunnel cleanly and resolves once it has ended; `ended` then resolves `{ outcome: "closed" }`.
- **`ended`** resolves with how the tunnel ended, and must be awaited:
  - `{ outcome: "lost", reason: "deleted" | "superseded", code, detail }` — the relay closed `4404` (the share was deleted, or is not the caller's) or `4409` (another run took it over). The share's addresses cannot reach this run again.
  - `{ outcome: "runner-unsupported", offered, cause, detail }` — the relay selected none of the `offered` subprotocols (`cause: "no-subprotocol"`), or the tunnel closed `4400` (`cause: "protocol-error"`). Retrying cannot help, so the engine does not.
  - It rejects only when the credential provider breaks its contract by rejecting.
- **`onEvent`** receives:
  - `{ type: "connected", epoch, reconnect, afterWarning }` on every completed handshake; `reconnect` is false on the run's first, `afterWarning` says a warning came since the last success.
  - `{ type: "warning", reason, detail, code?, command? }` once per distinct reason until a connect or a renewal succeeds. `reason` is `credential-refused` (`4401`), `sign-in-required` (with the provider's `command`), `credential-unavailable` (the provider's message as `detail`), `owner-limit` (`4429`), `runner-capacity` (`4503`), `timed-out` (`4408`, or 45 s of silence), `unreachable` (the upgrade failed) or `disconnected`. `detail` carries the relay's close text when a close caused it. The engine keeps retrying after every warning.
  - `{ type: "renewed", afterWarning }` when `auth` presented a renewed token.
  - `{ type: "forward-failed", port, message }` whenever a visitor stream could not be forwarded because the local port refused, broke or did not speak HTTP; `message` is the local error's own text. The visitor still gets the plain `502` and never sees `message`. It is an engine event only: the wire protocol is unchanged.
  - `{ type: "forward-recovered", port }` once, when a port that had a `forward-failed` answers a stream again, so a consumer can warn once per distinct failure until the port is back.

The engine reconnects with a capped, jittered backoff (1 s doubling to 30 s), asking the provider again on each attempt and presenting the epoch the relay last answered. It answers the relay's pings, closes `4408` after 45 s of receiving nothing, and sends `auth` well before the presented token expires (120 s before, asking for a token with at least 180 s left). `timings` overrides these clocks; only a test needs to.

## The runner credential provider

The engine reads no file and no environment, holds no key and never decodes a token. It asks one port, `RunnerCredentialProvider`, implemented by whoever owns the sign-in:

```ts
interface RunnerCredentialProvider {
  credential(request: { runnerUrl: string; minLifetimeMs: number; signal: AbortSignal }): Promise<RunnerCredentialAnswer>;
}
```

- **The caller states the minimum lifetime** it needs. A provider whose token would expire sooner refreshes it first.
- **`signal`** is aborted when the caller no longer wants the answer; the provider may then reject. It rejects for nothing else.
- **One attempt per call**: the provider does not retry a failed answer; the engine's reconnect loop is the only layer that does. A token request whose answer was lost is settled within the same attempt, never left to the next one.
- **Three outcomes**, as data:
  - `{ outcome: "credential", credential }` — `credential.accessToken` (opaque), `credential.expiresAt` (from the token response) and `credential.proof({ htm, htu, nonce? })`, which answers a **fresh DPoP proof on every call**: a new `jti`, `iat` now, `ath` the hash of this credential's token.
  - `{ outcome: "sign-in-required", runnerUrl, command }` — no usable grant; asking again cannot help until the user runs `command`.
  - `{ outcome: "unavailable", message }` — the provider could not answer this time; asking again may.

The engine asks on every connect and before every `auth`. A mid-run `sign-in-required` or `unavailable` is a warning and the engine keeps asking; it never ends the run.

## For a relay

A relay replays the `relay` rows of the vectors and may use the codec: `readClientControlMessage` (what the client sends, judged as the relay judges it), `readRelayControlMessage`, `encodeControlMessage`, `TunnelCloseCode`, the limits `TUNNEL_TEXT_MESSAGE_MAX_BYTES` / `TUNNEL_BINARY_MESSAGE_MAX_BYTES`, `SHARE_PORT_HEADER`, `tunnelProofUrl` (the `htu` a tunnel proof names) and `MessageSizeGuard`, which judges message sizes from the frame headers on the raw socket, so an oversize message is closed `4400` before its payload is buffered. The vectors ship in the package as `@telorun/share-tunnel/specs/vectors/<file>.json`.
