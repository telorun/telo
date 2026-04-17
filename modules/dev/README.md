# Dev module

The `Dev` module exposes a local HTTP API for development tooling. It provides a single resource kind — `Dev.Server` — that starts a loopback HTTP server, exposes declared `Invocable` resources as callable endpoints, and publishes a discovery file so the Telo Editor can locate it automatically.

The module is never used in production. It belongs in a dedicated `dev.yaml` manifest that imports the main application module and declares development tools alongside it.

---

## Concepts

**Dev.Server** — a `Service` that starts when the kernel boots and tears down when it stops. It mounts one HTTP route per entry in its `tools` list and one built-in `GET /inspect` endpoint that returns a snapshot of all loaded manifests.

**`dev.yaml` pattern** — the conventional entry-point for a development session. It imports the main application so all production resources (database connections, etc.) are available by alias. Dev tools declared in `dev.yaml` reference those production resources directly.

---

## Dev.Server

Starts a local HTTP server and mounts routes for each declared tool.

```yaml
kind: Dev.Server
metadata:
  name: DevApi
address: localhost:3579 # optional; default is localhost:3579
tools:
  - kind: ORM.MigrationGenerator
    name: UserMigration
  - kind: ORM.MigrationGenerator
    name: PostMigration
```

### Fields

| Field     | Type         | Required | Description                                                                                                    |
| --------- | ------------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `address` | string       | no       | `host:port` to bind. Defaults to `localhost:3579`. Always loopback unless explicitly set to another interface. |
| `tools`   | array of ref | yes      | `Invocable` resources to expose. Each entry is a `{ kind, name }` reference.                                   |

### HTTP API

| Method | Path                       | Description                                                                                       |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST` | `/_dev/invoke/:kind/:name` | Invokes the matching tool with the JSON request body as input. Returns the tool's output as JSON. |
| `GET`  | `/_dev/inspect`            | Returns a JSON snapshot of all manifests loaded by the kernel.                                    |

`:kind` uses dot notation (`ORM.MigrationGenerator`). `:name` matches `metadata.name`.

Only resources listed in `tools` are reachable via `/_dev/invoke`. The inspect endpoint is always available regardless of `tools`.

### Address override

The `--dev` CLI flag overrides the `address` field at runtime, following the same pattern as Node's `--inspect`:

```
telo --dev ./dev.yaml               # uses address from manifest, or default
telo --dev=3580 ./dev.yaml          # localhost:3580
telo --dev=0.0.0.0:3579 ./dev.yaml  # all interfaces (explicit escalation)
```

---

## The `dev.yaml` pattern

```yaml
# dev.yaml
kind: Telo.Application
metadata:
  name: my-app-dev
---
kind: Telo.Import
metadata:
  name: App
source: ./telo.yaml
---
kind: Dev.Server
metadata:
  name: DevApi
tools:
  - kind: ORM.MigrationGenerator
    name: UserMigration
---
kind: ORM.MigrationGenerator
metadata:
  name: UserMigration
connection:
  kind: Sql.Connection
  name: App.Db
model:
  kind: ORM.Model
  name: App.User
```

Running `telo ./dev.yaml` starts the full production application (via the `App` import) alongside the dev tools. The migration generator has direct access to `App.Db` — the same live database connection the main app uses — because it is a resolved reference to an already-initialized resource from the imported module.

Running `telo ./telo.yaml` (without `dev.yaml`) starts only the production application. No `Dev.Server` resource is declared, so no dev HTTP server starts.

---

## Importing the module

```yaml
kind: Telo.Import
metadata:
  name: Dev
source: pkg:npm/@telorun/dev@0.1.0
```
