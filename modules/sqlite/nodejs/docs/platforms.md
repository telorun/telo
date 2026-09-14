# Platforms

`SQLite.Connection` opens the database with `better-sqlite3` on Node and with
the built-in `bun:sqlite` on Bun. better-sqlite3 is a native addon built for one
platform and one Node ABI, so the module ships a prebuilt copy per platform in
its artifact's native layers; a host downloads only the one it runs.

## Supported Node hosts

| OS | Architectures | libc |
| --- | --- | --- |
| `linux` | `amd64`, `arm64`, `arm` | `gnu`, `musl` |
| `darwin` | `amd64`, `arm64` | — |
| `windows` | `amd64`, `arm64` | — |

Each at ABI `node-137` (Node 24) and `node-141` (Node 25).

A Node host outside that set fails when the connection is created, with
`ERR_NATIVE_FILE_UNAVAILABLE` naming the host tuple and every tuple the module
ships. Nothing is compiled on the host as a fallback. Bun needs no native file
and runs on any platform Bun supports.

## Baking an image

`telo run` downloads the addon on first use. To warm it ahead of time — for an
image built on one architecture and run on another — name the target platform
and ABI:

```console
$ telo install --platform linux/arm64/gnu --abi node-137
```

Without `--abi`, no addon is warmed, and install reports each one it skipped.

## Running from a source checkout

In a checkout the addons are not committed. The first Node run that opens a
connection stages the host's addon from better-sqlite3's GitHub release archive
into `native/`, verified against the `sha256` pinned in the module's `sources:`
block; later runs read it from there. When the archive cannot be fetched, or its
addon does not match the pin, the connection fails with
`ERR_NATIVE_FILE_UNAVAILABLE` naming the URL. To stage every tuple at once:

```console
$ telo release stage --module modules/sqlite
```

Bumping better-sqlite3 means editing `sources.better-sqlite3.version` and running
`telo release stage --pin --module modules/sqlite`, which rewrites every pin.
