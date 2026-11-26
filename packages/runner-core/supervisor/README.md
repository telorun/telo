# telo-runner-supervisor

The session supervisor: the main process of every `app-<name>` container a container runner creates. It sits idle until the runner sends `run`, then runs that one process — on a fresh pty or on pipes, in a process group of its own — streams its output, and reports how it ended. Beside that it forwards a port the run binds to the container's loopback (`/v1/port-forward`), so the runner reaches it and nothing else on the network does. The protocol is normative in [`../specs/supervisor-protocol.md`](../specs/supervisor-protocol.md); the runner's half is runner-core's `SupervisorClient`.

## Rules

- **No Node twin.** The supervisor runs inside an arbitrary app image: no shell, no libc, no Node, no telo. So it is one statically linked executable, and every file in `src/` says so in its header.
- **Knows nothing about telo.** It runs the argv it is handed and forwards the loopback port it is asked for; what a run means (`telo run --watch …`) and what listens on that port are runner-core's.
- **Pure-Rust dependencies only.** Nothing with a build script that compiles C, so the musl targets link with nothing but a linker.
- **Unversioned.** `publish = false`, version `0.0.0`, under the repository's root licence. It ships inside the runner build that carries it, and what a runner and a supervisor agree on is the protocol generation. runner-core's npm package does not ship this directory.

## Building

A development build, for the tests:

```sh
cargo build --locked -p telo-runner-supervisor
```

The release build that runners deliver is static, for `x86_64` or `aarch64`:

```sh
cargo build --release --locked -p telo-runner-supervisor --target <x86_64|aarch64>-unknown-linux-musl
```

`pnpm --filter @telorun/runner-core build:supervisor --target <triple>` runs the same. The executable is `target/<triple>/release/supervisor`.

- **Natively in `rust:alpine`** the musl target is the host and links statically as it is: `docker run --rm -v "$PWD":/src -w /src rust:alpine cargo build --release --locked -p telo-runner-supervisor --target x86_64-unknown-linux-musl`.
- **Cross-linking from a glibc host:** `rustup target add <triple>`, then set `CARGO_TARGET_<TRIPLE>_LINKER=rust-lld` (the triple upper-cased, `-` as `_`: `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld`).

## Tests

`cargo test -p telo-runner-supervisor` runs the unit tests and `tests/vectors.rs`: the supervisor's half of `messages.json` (it parses the runner's messages and port-forward queries and encodes its own messages), every output frame, and every exchange against the built executable. runner-core's `supervisor-vectors.test.ts` runs the runner's half (it encodes the runner's messages and port-forward queries and decodes the supervisor's), every output frame, and every exchange against this executable, built with `cargo build --locked` or named by `TELO_SUPERVISOR_BIN` (a musl build, say), and `supervisor-client.test.ts` drives `SupervisorClient` against it. Both TypeScript suites skip, naming the reason, off Linux or with no cargo and no `TELO_SUPERVISOR_BIN`. `fake-supervisor.test.ts` runs every exchange that starts no program, and every query `portForward` refuses, against `FakeSupervisor`. `tests/launcher.rs` covers `--slots` (`src/launcher.rs`, the one file with no counterpart in the protocol: it speaks none).

## Vectors

`vectors/` pins generation 2. A change to a vector is a change to the protocol, so the spec changes with it.

**`messages.json`** — `{ generation, runner, supervisor, portForward }`, each side `{ valid, invalid }` for the messages that side SENDS:

- a `valid` entry is `{ name, message }`: the sender encodes it as written, and the receiver accepts it. Runner messages are encoded by the runner's codec and accepted by the supervisor's; supervisor messages are encoded by the supervisor's and decoded to the same object by the runner's.
- an `invalid` entry is `{ name, text, close }`: the raw text frame, and the close code the receiver answers it with (`4426` for a `hello` of another generation, `4400` for anything else).

`portForward` is the query of a port forward: a `valid` entry `{ name, port, query }` is what the runner asks for `port` with and the supervisor reads back as it; an `invalid` entry `{ name, query, close }` (`query` `null` for none) is refused with `close`.

**`output-frames.json`** — `{ valid, invalid }`. A `valid` entry is `{ name, seq, stream, payloadHex, frameHex }` (`stream` is `tty`, `stdout` or `stderr`): encoding `seq`, `stream` and the payload gives `frameHex`, and decoding `frameHex` gives them back. An `invalid` entry is `{ name, frameHex }`, a frame the reader refuses.

**`exchanges.json`** — `{ workspace, exchanges }`. `workspace` maps relative paths to file contents, written into a fresh `--workspace` directory per exchange. Each exchange is `{ name, steps }`, run against a freshly started supervisor whose token is the runner's to present. A step acts on the connection its `on` names (`main` when absent):

| Step | Does |
|---|---|
| `{ connect: <name>, token: "valid" \| "wrong" \| "none", forward?: <query> }` | Opens a connection under that name, with the supervisor's token, another one, or none. With `forward` it is a port forward with that query (`"port=$<label>"` takes the port recorded under the label), whose binary frames are raw bytes. |
| `{ listen: <label>, serve: "echo" \| { flood: <n> } }` | Listens on a free `127.0.0.1` port, recorded under the label: `echo` writes back what each connection sends; `flood` writes `n` bytes of the flood pattern (byte `i` is `i % 251`) to each, then ends it. |
| `{ freePort: <label> }` | Records a `127.0.0.1` port nothing listens on. |
| `{ expectListenerClosed: <label> }` | Every connection that listener accepted has ended. |
| `{ sendBytes: <text> }` | Sends the text's UTF-8 bytes as a binary frame on a port forward. |
| `{ expectBytes: { text } \| { flood: <n> } }` | The forward's next bytes are the text, or `n` bytes of the flood pattern. |
| `{ pauseReading: <ms>, expectUnfinished?: <label> }` | Reads nothing from the connection for that long; `expectUnfinished` names a flood listener that must not have written every byte by then. |
| `{ send: <message> }` | Sends the message as a text frame. A string value `"$<label>"` anywhere in it is replaced by the seq recorded under that label. |
| `{ sendText: <text> }` | Sends the text as it is. |
| `{ sendStdin: <text> }` | Sends the text's UTF-8 bytes as a binary frame. |
| `{ expect: <message>, ignore?: [<field>…] }` | The next text frame equals the message, once each `ignore` field — which must be present — is removed. Output frames arriving first are kept for `expectOutput`. |
| `{ expectOutput: { stream, text \| contains, firstSeq? }, record?: <label> }` | The output kept for that stream, joined, equals `text` or contains `contains`. `firstSeq` is the seq its first frame must carry, a number or `"$<label>+1"`; `record` keeps the last frame's seq under the label. The kept output is then cleared. |
| `{ expectClose: <code> }` | The connection closes with that code; anything before it is skipped. |
| `{ expectSilence: <ms> }` | Nothing arrives for that long. |
| `{ close: <name> }` | Closes that connection normally. |
| `{ wait: <ms> }` | Waits. |
| `{ signalSupervisor: "SIGTERM" \| "SIGINT" }` | Signals the supervisor process. |
| `{ expectSupervisorExit: <status> }` | The supervisor exits with that status. |

A step's `withinMs` bounds how long it waits (5000 by default). Across a connection, every output frame's seq must be one more than the one before.
