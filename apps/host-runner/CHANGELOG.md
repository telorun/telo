# Changelog

## 0.5.0 - 2026-11-27
### Added
* The runner opens each application's debug-stream connection itself, a plain socket to the application's loopback --inspect address, through the runner core's inspect-endpoint opener; what an application runs and what a session reports are unchanged.

## 0.3.0 - 2026-11-22
### Added
* Every Run of a session's application receives its own TELO_HOST_STATE_DIR (apps/<app name>/ of the session's storage, owned by the session user, kept by suspend and removed with the session) and its own TELO_HOST_SECRET_SEED, derived from the runner's root seed, the session id and the application's name, over any value the client sent. The root seed is RUNNER_SECRET_SEED when set, else a secret-seed file the runner keeps in its state directory beside the session store; a value or file that is not 32 bytes of unpadded base64url refuses to boot, naming it. With the PostgreSQL session store and no RUNNER_SECRET_SEED no seed is delivered and the runner logs a startup warning. The local runner strips RUNNER_SECRET_SEED from every process it spawns.
### Security
* Refreshed locked dependency versions within their declared ranges, as part of a workspace-wide refresh that clears known security advisories.

## 0.2.0 - 2026-11-19
### Added
* A runner that serves the /v1 session contract over local processes on this machine, run as telo-host-runner: it takes the options telo runner took (--port, --host, --allow-remote, --allow-origin, --state-dir, --verbose, -o json), starts each session on the telo it bundles, and runs an application that pins another telo version on the verified release download. telo-host-runner telo <arguments> is that bundled telo. The npm package and the single-file executable carry a THIRD_PARTY_NOTICES file with the license text of every MIT package they bundle.
