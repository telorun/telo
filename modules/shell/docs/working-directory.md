# Working directory

Every command starts in a working directory, decided in two layers:

1. **The host's** — `Shell.LocalHost.cwd`, fixed when the host is declared. When
   omitted, the directory the application process runs in.
2. **The call's** — the optional `cwd` input of `Shell.Command` and
   `Shell.CommandStream`, chosen per invocation.

The call's directory overlays the host's, the same way the `env` input overlays
the host's base environment: when a call supplies `cwd` it wins, and when it
does not the host's applies.

## Relative paths

A relative per-call `cwd` is resolved **against the host's working directory**,
not against the application's. A host declared with `cwd: /srv/repos` and a
call with `cwd: api` runs in `/srv/repos/api`; an absolute per-call `cwd` is
used as written.

This is what lets one host stand for a root — a checkout, a workspace — and
each call name a directory inside it without knowing where that root is:

```yaml
kind: Shell.LocalHost
metadata: { name: repos }
cwd: /srv/repos
---
kind: Run.Sequence
metadata: { name: testService }
steps:
  - name: run
    inputs:
      args: [npm, test]
      cwd: !cel "inputs.service"     # e.g. "api" → /srv/repos/api
    invoke:
      kind: Shell.Command
      host: !ref repos
```

## Both command forms

The working directory is where the process starts, whichever form runs it:

- `args` executes `args[0]` directly, with no shell, in that directory.
- `command` starts `<shell> -c <command>` in that directory, so the command
  line sees it as its current directory.

## Hosts

The per-call directory travels through the `Shell.Host` execution seam as a
call-level option beside `env`, `stdin` and `timeoutMs`, so every host driver
receives it and resolves it in its own path semantics — the local host with the
local filesystem's rules, a remote host against the remote machine's.

## Not a boundary

Neither directory confines anything: a shell command line can `cd` elsewhere,
use absolute paths, or spawn children, and a relative per-call `cwd` may climb
out of the host's directory with `..`. Isolation comes from where the host runs,
not from this field.
