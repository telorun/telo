# @telorun/host-runner

The host runner serves the Telo runner `/v1` API over local processes on this machine, so an editor (or any client) can open workspace sessions and run their applications. It is the local-process backend of the [runner contract](../../packages/runner-core), with no isolation and no terminal, and nothing to install beyond itself. Telo Studio's desktop build ships it and starts it for you.

```console
$ npm install -g @telorun/host-runner
$ telo-host-runner --port 4600 --state-dir ~/.telo/runner --allow-origin tauri://localhost
telo-host-runner listening on http://127.0.0.1:4600
Applications run as pasi, from /home/pasi/.telo/runner.
```

Loopback only unless `--allow-remote`; no browser origin unless `--allow-origin <origin>`. Every session runs as the user who started the runner.

## Options

- `--port <n>` - Port to listen on (default `8061`; `0` picks a free one and reports it).
- `--host <address>` - Address to bind (default `127.0.0.1`).
- `--allow-remote` - Permit a non-loopback bind.
- `--allow-origin <origin>` - A browser origin allowed to drive the runner (repeatable).
- `--state-dir <dir>` - The runner's state directory: the session store (`sessions.sqlite`) and the root secret seed (`secret-seed`, created on first use, mode `0600`) and every session's directory (`sessions/<id>/workspace`, `sessions/<id>/agent`, `sessions/<id>/apps/<name>`), kept across suspends, runner restarts and reboots.
- `--verbose` - Log every request.
- `-o json` - Print the result as JSON: `{ url, host, port, stateDir }`, `stateDir` being the directory in use.
- `--help`

The state directory is `--state-dir`, else `RUNNER_STATE_DIR`, else the per-user default for application state: `$XDG_STATE_HOME/telo/runner` (`~/.local/state/telo/runner` when `XDG_STATE_HOME` is unset) on Linux, `~/Library/Application Support/telo/runner` on macOS, `%LOCALAPPDATA%\telo\state\runner` on Windows. It is never the temp directory or the telo cache.

Every Run of a session's application receives its own `TELO_HOST_STATE_DIR` — `sessions/<id>/apps/<name>` of the state directory, an absolute path — and its own `TELO_HOST_SECRET_SEED`, derived from the root seed, the session id and the application's name, over any value the client sent. The root seed is `RUNNER_SECRET_SEED` when set (32 bytes, unpadded base64url), else the `secret-seed` file in the state directory; it is never passed on to the processes the runner spawns. Renaming an application gives a new directory and new generated secrets, and rotating the variable or deleting the file rotates every session's.

## Exit status

- `0` - the runner stopped cleanly.
- `1` - it failed to start.
- `2` - the invocation was refused before any work began, with the reason on stderr: an unknown option, a non-loopback `--host` without `--allow-remote`, a `--port` outside 0..65535, a state directory that cannot be resolved, created or written (the message names `--state-dir` and `RUNNER_STATE_DIR`), a `RUNNER_SECRET_SEED` or `secret-seed` file that does not hold 32 bytes of unpadded base64url (named, never its contents), or `RUNNER_SESSION_USER`, the container runners' session user, which has no meaning here.

## The telo it runs on

The runner bundles a telo and starts every session on it by re-entering itself: `telo-host-runner telo <arguments>` is that bundled telo, with every command and option the CLI has.

```console
$ telo-host-runner telo --version
0.137.0
```

An application that pins another telo version runs on that release's own binary, downloaded for this platform, verified against the release's `checksums.txt` and cached under the user cache; one this machine does not hold yet is fetched when the session starts, and a failed fetch is that session's failed start with the reason. No process the runner starts carries `TELO_APP_CLI`.

Packaging goes through the same bundled telo, which is never a carrier: `telo-host-runner telo package` from a local single-file build is refused, and from the published npm package it downloads the verified release as the carrier, as an npm-installed telo does.

## Notices

The runner is under the Sustainable Use License; the CLI, kernel and analyzer it bundles are MIT. The npm tarball and the single-file executable carry a `THIRD_PARTY_NOTICES` file holding the license text of every MIT package bundled.
