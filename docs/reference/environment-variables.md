---
sidebar_label: Environment variables
slug: /reference/environment-variables
description: Every environment variable a Telo process reads outside the manifest's own bindings — host values, need variables, cache and registry settings, packaged apps, colour — which are hidden from controllers, and how inputs are resolved.
---

# Environment variables

Three kinds of variable reach a Telo process:

- **Names the application binds itself** — `variables:`, `secrets:` and `ports:`
  entries with `env:`. They are the application's contract, not the runtime's:
  see [Configuring an application](/learn/configuration).
- **Names the runtime reads** — the tables below. None of them needs a binding in
  the manifest.
- **Names a runner sets** for the application it starts — listed at the end.

## How an input is resolved

For each `variables:` / `secrets:` / `ports:` entry and each field of a need,
the first source with a value wins:

1. a value supplied by name by whoever started the application (a parent
   `App.Instance`);
2. the command line (`arg:`, `variables:` and `secrets:` only);
3. the environment variable `env:` names — the dotenv files `telo` loads are read
   into it first ([how](/learn/configuration#local-development));
4. `default:`;
5. an answer asked for at a terminal — only for an entry the first four leave
   empty, and never under `--no-input`, in a runner, or without a terminal.

An entry left empty that the running configuration requires is refused at load,
naming every variable it could have been read from. Normative:
`kernel/specs/application-arguments.md`.

## Hidden from controllers

The runtime reads these names itself and then withholds them from the
application:

- Every name an Application binds with `env:` reads back `undefined` from
  `process.env` and `ctx.env`, with a warning; the controller receives the value
  through `variables.*`, `secrets.*` and `ports.*`.
- Every need's variable — derived (`TELO_NEED_…`) or bound with `env:` — is
  hidden by its exact name, from `process.env` and `ctx.env` alike.
- The host values (`TELO_HOST_STATE_DIR`, `TELO_HOST_PUBLIC_URL_TEMPLATE`,
  `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE`) are hidden the same way, and are
  also stripped from the environment of an application started with
  `App.Instance`, which is a root of its own. The container-engine values are
  not hidden.

This is a guardrail against reading around a declared binding, not isolation:
every other variable passes through untouched.

## Host values

Set by whatever hosts the application, once per application. They answer needs
the manifest declares without naming a place. See
[Providing needs](/learn/providing-needs).

| Variable | Effect |
| --- | --- |
| `TELO_HOST_STATE_DIR` | A directory this one application owns. Every `Telo.DurableDirectory` need with no variable of its own becomes `<state dir>/needs/<need path>`, created at load. See [Durable directories](/learn/providing-needs#durable-directories). |
| `TELO_HOST_PUBLIC_URL_TEMPLATE` | An `http` / `https` origin with `{port}` optional. Answers each `Telo.PublicUrl` need that is the primary of its port. See [Deriving addresses](/learn/providing-needs#deriving-addresses-from-the-templates). |
| `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` | The same with `{label}` required in the host. Answers every other `Telo.PublicUrl` need. |

The runtime reads the first three. `TELO_HOST_CONTAINER_ENGINE_URL` and
`TELO_HOST_CONTAINER_ENGINE_TOKEN` are a convention instead: a manifest using
`Docker.Engine` binds them with `env:` (default `unix:///var/run/docker.sock`, no
token), and a runner with session containers on sets both to its own engine
route. They are not hidden from a started application.

A malformed template is refused at load (`ERR_NEED_HOST_VALUE_INVALID`) naming
the variable, never its value.

## Need variables

`TELO_NEED_<PATH SEGMENTS>__<FIELD>`: `TELO_NEED_`, then each segment of the need
path and the field in upper case with `_` at word boundaries, joined by `__`.
`Orders.databaseAccess` field `url` is `TELO_NEED_ORDERS__DATABASE_ACCESS__URL`.
The root Application may bind a field's name instead with `env:`
(`env: { url: DATABASE_URL }`); the bound name replaces the derived one. Run
`telo needs report <manifest>` for the exact names — it boots nothing. The rule
and the table of examples are in
[Providing needs](/learn/providing-needs#one-environment-variable-per-field).

## Cache, registry and egress

| Variable | Read by | Effect |
| --- | --- | --- |
| `TELO_CACHE_DIR` | run, install, check | Relocates the `.telo` cache root. Without it the root is beside `telo-workspace.yaml` when one sits above the manifest, otherwise beside the manifest — [where the cache lands](/deploy/docker#where-the-cache-lands). Ignored inside a packaged application. |
| `TELO_NPM_CACHE_DIR` | run | Where the controller install root of an `http(s)` entry manifest lives; default `$XDG_CACHE_HOME/telo/remote`, else `~/.cache/telo/remote`. A local manifest's install root is under its cache root. |
| `TELO_PKG_MANAGER` | run, install | The package manager used for controllers delivered over npm; default `npm`. |
| `TELO_CONTROLLER_BUNDLE` | controller loading | `0`, `false`, `no` or `off` stops the kernel bundling an installed controller package and loads its files loose. On by default. |
| `TELO_EGRESS` | run, install, check | `public-only` refuses module fetches from private, loopback or link-local hosts. Read from the real environment only: a manifest binding cannot change it. See [Security & supply chain](/deploy/security#egress-control). |
| `TELO_OCI_REGISTRY` | `telo release`, `telo upgrade` | The `oci://host/org` base modules are published to when neither the workspace nor `--registry` names one. It is a publish destination, not a mirror for pulls — see [Air-gapped and private registries](/deploy/docker#air-gapped-and-private-registries). |
| `TELO_HUB_URL` | `telo search` | Hub to search; overridden by `--hub-url`. |
| `DOCKER_CONFIG` | OCI pulls | Directory holding the `config.json` registry credentials are read from; default `~/.docker`. |
| `TELO_DEBUG_UI_PATH`, `TELO_DEBUG_UI_URL`, `TELO_DEBUG_UI_VERSION` | `--inspect` | A local build of the inspection UI, the CDN base it is fetched from, or the version to fetch. Only an inspected run reads them. |

## Packaged applications

| Variable | Effect |
| --- | --- |
| `TELO_APP_DIR` | Where a packaged binary unpacks (default `~/.cache/telo`, `~/Library/Caches/telo`, `%LOCALAPPDATA%\telo`; then a temporary directory). The one knob a read-only container needs. |
| `TELO_APP_CLI` | `1` makes the binary the telo CLI for one start; empty or unset runs the application; anything else is refused with exit status 2. Removed from the environment before the application sees it. |
| `TELO_REPO` | The GitHub repository `telo package` downloads another platform's carrier from; default `telorun/telo`. |

See [Packaging an application](/learn/packaging-an-app).

## Colour

`NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE` and `TERM` decide
whether the console log sink colours its output, in that order; see
[Logging](/build/logging#colour-from-the-environment). Log level is not an
environment variable — bind one in the manifest.

## Set by a runner

A runner (`telo runner`, the Docker runner, the Kubernetes runner) is configured
by its own `RUNNER_*` variables, and an agent it hosts by `AGENT_*` ones; they
configure the runner process, not the applications it runs. Each runner documents
its own: [`apps/docker-runner`](https://github.com/telorun/telo/blob/main/apps/docker-runner/README.md),
[`apps/k8s-runner`](https://github.com/telorun/telo/blob/main/apps/k8s-runner/README.md)
and the shared contract in
[`packages/runner-core`](https://github.com/telorun/telo/blob/main/packages/runner-core/README.md).
A runner starts each application with `--no-input`, so a missing input is a
refusal, and passes `TELO_CACHE_DIR`, `TELO_HOST_STATE_DIR` and the public-URL
templates for the sandbox it provides.
