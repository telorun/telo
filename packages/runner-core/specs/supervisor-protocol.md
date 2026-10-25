# The session supervisor protocol — generation 1

**Status: normative.** Every app container a container runner creates runs the session supervisor as its main process, and the runner drives it over the protocol below. The supervisor's implementation is the `telo-runner-supervisor` crate (`packages/runner-core/supervisor/`), the runner's is runner-core's `SupervisorClient`. Both run the vectors in `packages/runner-core/supervisor/vectors/`; a behaviour the vectors pin and this text contradicts is a defect in this text.

A runner and a supervisor agree on the **generation** and nothing else: the supervisor ships inside the runner build that delivers it and has no version of its own. A change to anything below is a new generation.

The supervisor knows nothing about telo. It runs the argv it is handed.

## 1. Starting the supervisor

The supervisor is one statically linked Linux executable, `supervisor`, depending on nothing in the image it runs in.

| Input | Meaning |
|---|---|
| `TELO_SUPERVISOR_LISTEN` | Required. The `ip:port` it listens on (`0.0.0.0:<port>`; `127.0.0.1:0` picks a free port). |
| `TELO_SUPERVISOR_TOKEN` | Required, non-empty. The one bearer token a connection must present. |
| `--workspace <dir>` | Optional, absolute. What a relative `run.cwd` resolves against. Default `/workspace`. |
| `--slots <n>` | Optional, a positive count. The executable then runs no protocol of its own: it starts `n` supervisors, slot `i` listening on `TELO_SUPERVISOR_LISTEN`'s port plus `i` with the same token and `--workspace`, so one container offers `n` independent one-run supervisors. SIGTERM or SIGINT is forwarded to every slot (§ 7) and it exits `0` once they ended; a slot that ends by itself ends the others and the launcher exits with its status. The protocol is unchanged and is spoken to each slot. |

Both variables are removed from the supervisor's environment before anything else starts, so no run inherits them. Any other argument is refused.

**Exit status:** `2` for a configuration it refuses, `1` when it cannot listen or start, `0` after a shutdown (§ 7), `70` when the output seq is exhausted (§ 5).

**Log:** the supervisor's stdout carries nothing; its stderr carries only its own log, one line per entry: `supervisor <info|warn|error>: <message>`. Once listening it writes `supervisor info: listening on <ip:port>`, with the port actually bound.

## 2. The channel

One WebSocket at `GET /v1/supervisor` on the listen address. Any other path is answered `404` without an upgrade.

The connection carries `Authorization: Bearer <token>` (the scheme is case-insensitive). It is judged once the upgrade completes:

| Credential | Close |
|---|---|
| no `Authorization`, another scheme, or an empty token | `4401` |
| a token that is not `TELO_SUPERVISOR_TOKEN` | `4403` |

The comparison takes a time that depends on the lengths only.

- **Text frames** are JSON control messages: one object with a string `type`.
- **Binary frames** from the runner are stdin bytes (§ 4.5); from the supervisor, output frames (§ 5).

## 3. The handshake

**The runner speaks first:** `{ "type": "hello", "generation": 1, "lastSeq": <n> }`, `lastSeq` an integer from `0` to `2³²−1`, the last output seq the runner holds from this supervisor (`0` for none).

- No first message within **10 s** closes `4408`.
- A `hello` of another generation closes `4426`. The generation is judged **before any other field**, since another generation may define them differently.
- A first message that is anything but a valid `hello` closes `4400`.

**The supervisor answers** `{ "type": "hello", "generation": 1, "instance": <id>, "state": "idle" | "running", "runId"?: <id> }`:

- `instance` is random per supervisor process (32 hex digits). A runner holding seqs from another instance is talking to a restarted container: its run is gone and its seqs mean nothing here.
- `runId` is present exactly when `state` is `running`, naming the live run.

Right after its `hello`, the supervisor sends every output frame it retains with a seq above `lastSeq`, oldest first, then live output — with nothing lost or repeated between the two.

**One connection drives a supervisor.** A connection that completes its handshake supersedes the one before it, which is closed `4409`. A second `hello` on one connection closes it `4400`.

## 4. Messages

Every message is validated strictly: a missing field, a field of the wrong type or out of range, and a field this generation does not define all close the connection `4400`. The ranges are the same everywhere: `runId` a non-empty string; `cols` / `rows` integers from `1` to `10000`; `graceMs` an integer from `0` to `3600000` (one hour).

### 4.1 Runner → supervisor

| Message | Fields |
|---|---|
| `hello` | `generation`, `lastSeq` (§ 3) |
| `run` | `runId`; `argv`, a non-empty array of strings, the first non-empty, none holding NUL; `env`, an object of string values, each name non-empty and holding neither `=` nor NUL, no value holding NUL; `cwd`, a non-empty path; `io`, `"tty"` or `"streams"`; `cols` and `rows`, both or neither |
| `stop` | `runId`, `graceMs` |
| `resize` | `cols`, `rows` |

### 4.2 Supervisor → runner

| Message | Fields |
|---|---|
| `hello` | `generation`, `instance`, `state`, `runId` when running (§ 3) |
| `started` | `runId` |
| `exited` | `runId` and exactly one of `code` (the exit status) and `signal` (the terminating signal's name, `"SIGTERM"`) |
| `failed` | `runId`, `reason`: a spawn that never ran |
| `refused` | `runId`, `code`: `"run_active"` or `"no_run"` |

The runner validates these as strictly, and closes `4426` on a supervisor `hello` of another generation and `4400` on anything else malformed.

### 4.3 `run`

- **No run is live:** the supervisor starts the process (§ 6) and answers `started`, or `failed` when it cannot start it.
- **This run is live:** `started` again; nothing else happens.
- **Another run is live:** `refused` with `run_active`.
- **This run is the one that ended last:** its ending again (`exited` or `failed`); it is never started a second time.

Only the most recent ending is remembered.

### 4.4 `stop`

- **This run is live:** SIGTERM to its process group, then SIGKILL when it has not ended after `graceMs`. Nothing is answered now: the `exited` follows when it ends. A `stop` of a run already stopping changes nothing.
- **This run is the one that ended last:** its ending again.
- **Otherwise:** `refused` with `no_run`.

### 4.5 `resize` and stdin

`resize` sets the live run's pty size. It is ignored under `streams` and when no run is live.

A binary frame from the runner is written to the live run's stdin — the pty under `tty`, its stdin pipe under `streams` — in order, as raw bytes. With no live run it is discarded. A run that closed its stdin discards what follows.

## 5. Output

Every chunk a run writes is one binary frame `[seq:4 BE][stream:1][payload]`, the byte channel's framing:

- `stream` is `0` (`tty`) under `tty`, and `1` (`stdout`) or `2` (`stderr`) under `streams`, which stay separate.
- `seq` starts at `1` and grows by one per frame for the supervisor process's whole life, across runs. A supervisor that would pass `2³²−1` exits `70`.
- **The ring:** the supervisor retains frames up to 1 MiB of payload, and always the newest frame. A runner that reconnects asking for seqs the ring no longer holds is sent what it does hold; the gap is visible in the seqs.
- **Backpressure:** a connection with more than 4 MiB queued and unsent is closed `4429`. The run continues, and the reconnect is replayed from the ring.

**A message with no connection to take it is not queued.** A reconnecting runner learns the state from `hello`, the output from the ring, and an ending it missed by asking with `stop` or `run`, which answer it (§ 4.3, § 4.4) and start or stop nothing. **A dropped connection stops nothing.**

## 6. Processes

- **One process group per run.** The run is started in a session of its own, with an empty signal mask.
- **`tty`:** a fresh pty per run, of `cols` × `rows` (default 80 × 24), as the run's controlling terminal and its stdin, stdout and stderr. `TERM` is `xterm` when neither `env` nor the supervisor's environment sets it. A run that left a terminal in raw mode cannot affect the next one.
- **`streams`:** a pipe each for stdin, stdout and stderr.
- **Environment:** the supervisor's own (the container's, without the two variables of § 1), overlaid with `env`. `env` lives only in the supervisor's memory and the run's environment.
- **Working directory:** `cwd`, resolved against `--workspace` when relative.
- **Ending:** when the run's process ends, the rest of its group is sent SIGKILL. `exited` is sent once the process has ended and its output is closed, or 2 s after it ended when something still holds its output.
- **Reaping:** the supervisor reaps every child, orphans included — as PID 1, or as the child subreaper when it is not.

## 7. Shutdown

On SIGTERM or SIGINT the supervisor stops accepting connections and forwards SIGTERM to the live run's group. Once the run has ended — `exited` sent — it closes the connection `1001` and exits `0`. It never escalates to SIGKILL itself: the container engine's own grace does.

## 8. Close codes

| Code | Sent by | Meaning |
|---|---|---|
| `1001` | supervisor | It is shutting down. |
| `4400` | either | A malformed message, or one out of order. |
| `4401` | supervisor | No bearer token. |
| `4403` | supervisor | The wrong token. |
| `4408` | supervisor | No `hello` within 10 s. |
| `4409` | supervisor | Another connection took over. |
| `4426` | either | A `hello` of another generation. The runner recreates the pod. |
| `4429` | supervisor | The runner fell more than 4 MiB behind. |

## 9. Vectors

`packages/runner-core/supervisor/vectors/` pins this generation; the crate README describes the format. `messages.json` and `output-frames.json` are run by both implementations' codecs, `exchanges.json` against the built executable by the crate's tests and by runner-core's.
