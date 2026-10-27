# Writing integration tests that start a real service

A Telo test is an application: a `Telo.Application` whose `targets:` run
steps and assertions. Most tests need nothing outside the manifest — a feature
library is imported and invoked, and an outbound API is replaced by a mock
`Http.Server` standing inside the test. This guide is for the other case: the
behaviour under test lives in a real service — a PostgreSQL database, a
message queue, a cache server — and only that service can answer.

Such a test **starts the service itself**, as a disposable container, and
removes it when it ends. Nothing has to be running beforehand except a
container engine, so the same file runs alone under `telo run`, inside a test
suite, and in a runner session, unchanged. The worked example is PostgreSQL;
every other service is the same pattern with another image.

Take the exact schema of every kind named here — `Container.Instance`,
`Container.Port`, `Container.LogReady`, `Docker.Engine`, `Test.Suite`,
`App.Instance`, `Assert.Equals`, your database connection — and the
`imports:` line for each module from `get_kinds` (the `container`, `docker`,
`test`, `app`, `run` and `assert` modules, plus your database's). Snippets
below write each import as `<ref>@<version>#<pin>`; write what `get_kinds`
returns. A `Telo.*` kind (`Telo.Application`) is built in: `get_kinds` returns
it with no import line, and nothing is imported for it.

## When a mock cannot stand in

Start a real service when what you are testing is the service's own
behaviour as your manifest uses it: SQL that must run on the real engine, a
schema migration across restarts, a transaction's isolation, a constraint,
a `LISTEN`/`NOTIFY`, a queue's delivery. When the test only needs *an* answer
from a dependency — a vendor's HTTP API, a webhook receiver — mock it with an
`Http.Server` in the test's own `with:` scope instead. A container costs
seconds per test and needs an engine; a mock costs nothing.

## Where the files go

```
myapp/
  telo.yaml                          # the application
  orders.yaml                        # a feature library the app imports
  tests/
    telo.yaml                        # the default suite: needs nothing running
    place-order.yaml                 # an ordinary test
    __fixtures__/
      postgres/telo.yaml             # the fixture library: one server per import
    integration/
      telo.yaml                      # the integration suite: needs an engine
      orders-in-postgres.yaml        # a test that starts PostgreSQL
```

- A test that starts a container goes in a **directory of its own**
  (`tests/integration/`), run by a **suite of its own**. The default suite
  (`include: ["*.yaml"]` in `tests/`) does not reach a subdirectory, so it
  keeps passing on a machine with nothing installed — and a red default suite
  still means the code is wrong, not that something was not up.
- Fixtures live under `__fixtures__/`, which every suite excludes.

The integration suite is an application whose one target is a `Test.Suite`:

```yaml
kind: Telo.Application
metadata: { name: OrdersIntegrationTests, version: 1.0.0 }
imports:
  Test: oci://ghcr.io/telorun/test@<version>#<pin>
targets:
  - !ref all
---
kind: Test.Suite
metadata: { name: all }
include: ["*.yaml"]
exclude: ["telo.yaml", "**/__fixtures__/**"]
```

Both `exclude` entries are needed: `*.yaml` matches the suite's own file,
which would run itself, and writing `exclude` replaces its default, so
`__fixtures__` must be restated.

## The engine

`Docker.Engine` reaches a Docker-API engine — a local Docker or Podman daemon,
or the engine a runner serves its session. Bind it to the two environment
variables a runner sets, with local defaults:

```yaml
variables:
  engineUrl:
    env: TELO_HOST_CONTAINER_ENGINE_URL
    type: string
    default: unix:///var/run/docker.sock
secrets:
  engineToken: { env: TELO_HOST_CONTAINER_ENGINE_TOKEN, type: string, default: "" }
---
kind: Docker.Engine
metadata: { name: engine }
endpoint: !cel "variables.engineUrl"
token: !cel "secrets.engineToken"
```

Locally nothing is set and the developer's daemon is used. In a runner
session both variables point at an engine of that session's own, with a token
minted for it, so the same file runs there unchanged. Never hard-code a socket
path or a host.

## The container and its address

```yaml
kind: Container.Instance
metadata: { name: server }
engine: !ref engine
image: postgres:18
user: "999:999"
env:
  POSTGRES_PASSWORD: postgres
ports: [5432]
readiness:
  kind: Container.LogReady
  text: database system is ready to accept connections
  times: 2
lifetime: 2h
---
kind: Container.Port
metadata: { name: endpoint }
container: !ref server
port: 5432
```

- `Container.Instance` is pulled, created, started and awaited when the
  application starts, and force-removed with its volumes when it stops — also
  when its start fails part-way.
- `ports` publishes container ports on the engine's loopback interface, each
  on a port the engine chooses. Never pick a host port yourself.
- `user` is a numeric `uid:gid`: an engine that refuses root (a Kubernetes
  runner session does) still runs it. Use the image's own unprivileged user.
- `readiness` decides when the service is up. `Container.LogReady` waits for
  `text` to appear `times` times in the container's output — PostgreSQL
  prints its line once for the initialization pass and once more when it
  restarts to serve, hence `times: 2`. Left out, the container is ready as
  soon as it is running, which for a database is too early.
- `lifetime` is how long the container may outlive its start. Every
  container is labelled with its expiry, and every start on the same engine
  first removes the expired ones — that is the cleanup after a killed test
  run. Set it well above the longest the test can run.
- `env`, `command`, `entrypoint` and `startupTimeout` are there when the image
  needs them; only the names of `env` entries are ever published, never the
  values.

`Container.Port` reports where one published port is reached, as observed
state: `resources.endpoint.status.host` and `resources.endpoint.status.port`
(a TCP port). It is the binding the engine reports — `127.0.0.1` and the
chosen port locally, the session's address for the container in a runner.
Never assume `localhost` or the container port. A `port` the container does
not list under `ports` is refused by `telo check`
(`CONTAINER_PORT_NOT_EXPOSED`).

Both are providers, so their status is readable in a **startup field** of
another resource — the address of a database — and the read orders the reader
after the container. A PostgreSQL connection is opened over a database-access
fulfilment, whose URL is written as its members so the type escapes them:

```yaml
kind: Postgres.DatabaseAccess
metadata: { name: databaseAccess }
fields:
  url:
    scheme: postgres
    host: !cel "resources.endpoint.status.host"
    port: !cel "resources.endpoint.status.port"
    user: postgres
    password: postgres
    path: /postgres
---
kind: Postgres.Connection
metadata: { name: db }
access: !ref databaseAccess
```

**Declare the engine, the container and the port at the top level of a file,
or import them — never inside a `Run.Sequence`'s `with:`.** A scoped
resource's startup fields cannot read a scoped sibling's status, so a
connection beside a container in one `with:` cannot learn its address.

## A fixture library: one server per import

Several tests need the same server, so put the engine, the container and the
port in a fixture library under `tests/__fixtures__/postgres/` and export the
instances a test needs. Each test imports it; the default library lifecycle
(`isolated`) gives **every import its own instantiation — its own container**,
so tests running at the same time never share a database.

```yaml
# tests/__fixtures__/postgres/telo.yaml
kind: Telo.Library
metadata:
  name: PostgresFixture
  version: 1.0.0
  description: >-
    A disposable PostgreSQL server for one test: user postgres, password
    postgres, database postgres. Removed with its data when the test ends.
imports:
  Container: oci://ghcr.io/telorun/container@<version>#<pin>
  Docker: oci://ghcr.io/telorun/docker@<version>#<pin>
  Postgres: oci://ghcr.io/telorun/postgres@<version>#<pin>
variables:
  engineUrl:
    type: string
    description: The container engine's endpoint.
secrets:
  engineToken:
    type: string
    description: The bearer token the engine asks for; empty for none.
exports:
  resources: [server, endpoint, databaseAccess]
---
kind: Docker.Engine
metadata: { name: engine }
endpoint: !cel "variables.engineUrl"
token: !cel "secrets.engineToken"
---
kind: Container.Instance
metadata: { name: server }
engine: !ref engine
image: postgres:18
user: "999:999"
env:
  POSTGRES_PASSWORD: postgres
ports: [5432]
readiness:
  kind: Container.LogReady
  text: database system is ready to accept connections
  times: 2
lifetime: 2h
---
kind: Container.Port
metadata: { name: endpoint }
container: !ref server
port: 5432
---
kind: Postgres.DatabaseAccess
metadata: { name: databaseAccess }
fields:
  url:
    scheme: postgres
    host: !cel "resources.endpoint.status.host"
    port: !cel "resources.endpoint.status.port"
    user: postgres
    password: postgres
    path: /postgres
```

A library reads no environment: its `variables:` / `secrets:` carry no
`env:`. The **test** binds the two environment variables and passes them
down at the import. Exporting `databaseAccess` lets a test connect with
`access: !ref Pg.databaseAccess`; `server` lets one that needs only "the
server is up" depend on it, and `endpoint` gives one that needs the address
itself the host and port.

## The test

The test imports the fixture, connects to its port, hands that connection to
the library under test as a resource input, and asserts:

```yaml
# tests/integration/orders-in-postgres.yaml
kind: Telo.Application
metadata:
  name: OrdersInPostgres
  version: 1.0.0
  description: Placing an order stores it in PostgreSQL. Needs a container engine.
imports:
  Pg:
    source: ../__fixtures__/postgres
    variables: { engineUrl: !cel "variables.engineUrl" }
    secrets: { engineToken: !cel "secrets.engineToken" }
  Orders:
    source: ../../orders.yaml
    resources: { connection: !ref db }
  Sql: oci://ghcr.io/telorun/sql@<version>#<pin>
  Postgres: oci://ghcr.io/telorun/postgres@<version>#<pin>
  Run: oci://ghcr.io/telorun/run@<version>#<pin>
  Assert: oci://ghcr.io/telorun/assert@<version>#<pin>
variables:
  engineUrl: { env: TELO_HOST_CONTAINER_ENGINE_URL, type: string, default: "unix:///var/run/docker.sock" }
secrets:
  engineToken: { env: TELO_HOST_CONTAINER_ENGINE_TOKEN, type: string, default: "" }
targets:
  - !ref placesAnOrder
---
kind: Postgres.Connection
metadata: { name: db }
access: !ref Pg.databaseAccess
---
kind: Run.Sequence
metadata: { name: placesAnOrder }
steps:
  - name: schema
    invoke: { kind: Sql.Command, connection: !ref db }
    inputs:
      sql: CREATE TABLE IF NOT EXISTS orders (id text PRIMARY KEY, sku text NOT NULL, quantity integer NOT NULL)
  - name: id
    value: !cel "uuidv4()"
  - name: place
    invoke: !ref Orders.placeOrder
    inputs: { id: !cel "steps.id.result", sku: ABC, quantity: 2 }
  - name: read
    invoke: { kind: Sql.Query, connection: !ref db }
    inputs:
      sql: !sql "SELECT sku, quantity FROM orders WHERE id = ${{ steps.id.result }}"
  - name: assert
    invoke: { kind: Assert.Equals }
    inputs:
      actual: !cel "steps.read.result.rows"
      expected: [{ sku: ABC, quantity: 2 }]
```

- The imported fixture's exports are referenced as `!ref Pg.databaseAccess`
  and `!ref Pg.server`, and read as `resources.Pg.endpoint.status…`.
- The library under test declares the connection it needs as a resource
  input (`resources: { connection: { kind: Sql.Connection } }` on its
  `Telo.Library`) and the test supplies one. That is why a library never
  builds its own connection from a URL: the test, and the application, decide
  what it talks to.
- `Assert.Equals` deep-compares the whole result against a literal. Assert
  the rows you wrote, never a count of a shared table.

## Handing the address to something the test starts

The service's address is known only once its container is up, so it is passed
on, never written down:

- **An application under test** — run it with `App.Instance` in a
  `Run.Sequence`'s `with:` and supply the address through the child's own
  declared `variables:` (by the names it declares, never env spellings):

  ```yaml
  kind: Run.Sequence
  metadata: { name: servesOrders }
  with:
    - kind: App.Instance
      metadata: { name: app }
      source: ../../telo.yaml
      ports: { http: 19471 }
      variables:
        dbHost: !cel "resources.Pg.endpoint.status.host"
        dbPort: !cel "resources.Pg.endpoint.status.port"
  targets:
    - !ref app
  steps:
    - name: call
      invoke: { kind: HttpClient.Request, url: "http://127.0.0.1:19471/orders" }
  ```

  The application binds `dbHost` / `dbPort` to its own environment variables
  and builds its connection from them, so production configures it the same
  way.
- **A suite of separate applications against one server** — when each boot
  must read what an earlier process wrote (a migration across restarts), the
  test starts the server once and runs the boots through a `Test.Suite`
  whose `env:` map hands each the address; give the suite `concurrency: 1`
  and number the files, since discovery sorts by path:

  ```yaml
  kind: Test.Suite
  metadata: { name: boots }
  include: ["__fixtures__/boots/*.yaml"]
  exclude: []
  concurrency: 1
  env:
    DB_HOST: !cel "resources.Pg.endpoint.status.host"
    DB_PORT: !cel "string(resources.Pg.endpoint.status.port)"
  ```

  Each boot declares `dbHost: { env: DB_HOST, type: string }` and
  `dbPort: { env: DB_PORT, type: integer }`, and connects over an inline
  fulfilment built from them:

  ```yaml
  kind: Postgres.Connection
  metadata: { name: db }
  access:
    kind: Postgres.DatabaseAccess
    fields:
      url:
        scheme: postgres
        host: !cel "variables.dbHost"
        port: !cel "variables.dbPort"
        user: postgres
        password: postgres
        path: /postgres
  ```

## Keeping tests independent

- **One server per test file.** Import the fixture in each test; never share
  one container between files through anything but a suite's `env:`.
- **Identify what a run writes.** Generate keys with `uuidv4()` and assert on
  those rows. A test that reads "everything in the table" breaks the day two
  tests write it.
- **Start clean where state persists across boots.** A multi-boot test drops
  its own schema or namespace first, so a previous run's leftovers never
  decide what this one sees.
- **One port per test.** A server the test starts (an `App.Instance`, a mock)
  gets a port no other test uses, so tests can run concurrently.
- **One directory per test.** An application that keeps state declares a
  `Telo.DurableDirectory` need; the test supplies it under `App.Instance`'s
  `needs:` by the child's need name (`needs: { state: { path: <dir> } }`, or a
  `!ref` to a need or fulfilment of the test's own), which wins over the
  child's environment, so no two tests share files. `telo check` holds every
  name under `variables` / `secrets` / `ports` / `needs` to what the child
  declares.
- **`lifetime` above the test's duration**, so a sweep never removes a
  container a slow run is still using.

## What failures mean

| Code | Meaning | Usual fix |
| --- | --- | --- |
| `CONTAINER_PORT_NOT_EXPOSED` | a `Container.Port` names a port the container does not publish (`telo check`; `ERR_…` at creation) | add it to `ports` |
| `ERR_CONTAINER_ENGINE_UNREACHABLE` | the engine at `engineUrl` did not answer | start a daemon, or check the variables a runner set |
| `ERR_CONTAINER_START_FAILED` | the engine refused a pull, create or start, or reported no usable binding | the message carries the engine's reason: an image name, a refused field |
| `ERR_CONTAINER_NOT_READY` | `startupTimeout` passed before readiness | raise `startupTimeout` for a slow pull; check the readiness `text` |
| `ERR_CONTAINER_EXITED` | the container stopped before it was ready; carries its exit code and last output lines | read the output: a missing env var, a wrong `user` |

After any of these the container is gone; nothing needs cleaning up by hand.

## Running

Run one test with `telo run tests/integration/orders-in-postgres.yaml`, or
the whole set through its suite manifest. Run the default suite without an
engine and the integration suite where one is available — a CI job that
provides a container engine, or a runner session, which provides its own.
