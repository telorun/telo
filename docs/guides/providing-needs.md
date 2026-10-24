---
description: "Provision what an application needs before starting it: read the needs report, set one environment variable per field, and know how each variable is named, read and checked."
---

# Providing needs

An application, and every library it imports, may declare **needs** — typed
requests for something it cannot create itself, such as the address and
credentials of a database (see [Declaring a need](/learn/declaring-a-need)).
A need that no import supplies reaches the application being run, and is read
from the environment when it loads. Nothing is fetched, provisioned or asked of
a host at boot. The one other door is an application that runs it: a parent
starting it with `App.Instance` supplies its needs by name (see
[Needs supplied by a parent](#needs-supplied-by-a-parent)).

Whoever starts the application — a person, a CI job, an operator — reads the
needs report, provides each entry, and sets its environment variables.

## The needs report

```bash
telo needs report ./shop
```

lists, with nothing booted, every need the application reads from the
environment:

```
databaseAccess  DatabaseAccess (oci://ghcr.io/acme/postgres-types)
  declared by ./
  version >=16.0.0
  features pgvector
  url  DATABASE_URL  bound, required, sensitive

Orders.cache  DatabaseAccess (oci://ghcr.io/acme/postgres-types)  optional
  declared by ./orders
  url  TELO_NEED_ORDERS__CACHE__URL  derived, required, sensitive
  schema  TELO_NEED_ORDERS__CACHE__SCHEMA  derived, optional
```

A need supplied at an import is not in it: it is the importer's, not the
environment's. The report carries no values.

Under `-o json` it is a versioned document — fields are added within a
version, never changed:

```json
{
  "reportVersion": 1,
  "needs": [
    {
      "path": "Orders.cache",
      "declaredBy": "./orders",
      "type": { "module": "oci://ghcr.io/acme/postgres-types", "name": "DatabaseAccess" },
      "version": null,
      "features": [],
      "parameters": {},
      "optional": true,
      "fields": {
        "url": {
          "env": "TELO_NEED_ORDERS__CACHE__URL",
          "envSource": "derived",
          "required": true,
          "sensitive": true
        },
        "schema": {
          "env": "TELO_NEED_ORDERS__CACHE__SCHEMA",
          "envSource": "derived",
          "required": false,
          "sensitive": false
        }
      }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `path` | The need path: its name beneath each importer's alias, `.`-separated. A `lifecycle: shared` library's needs sit beneath its own name, directly under the root. |
| `declaredBy` | The module declaring the need. |
| `type.module`, `type.name` | The need type: the module declaring it, and its name there — `Telo` for a type the kernel declares (`Telo.PublicUrl`, `Telo.PublicHostPattern`, `Telo.DurableDirectory`). A type's identity does not depend on the module's version. |
| `version` | The version range the fulfilment must be within (`>=16.0.0`), or `null` when the need states none. A consumer of the need reports the real version and the kernel refuses one outside it with `ERR_NEED_UNMET`, naming the variable it was read from. |
| `features` | The features the fulfilment must carry, `[]` when it asks for none. Checked the same way. |
| `parameters` | What the need asks of its fulfilment, as the need type's `parameters` schema admits, with every default that schema declares filled in — so a host reads `size: 1Gi` from a `Telo.DurableDirectory` that wrote no parameters, and never restates a type's defaults. `{}` when the type declares none. |
| `optional` | Whether the application runs without it. |
| `fields.<field>.env` | The one environment variable the field is read from. |
| `fields.<field>.envSource` | `bound` — named by the application's `env:`; `derived` — from the need path. |
| `fields.<field>.required` | Whether the need type requires the field. |
| `fields.<field>.sensitive` | Whether the field is sensitive — the need type marks it `x-telo-sensitive`, or its value type declares a sensitive member (a `Telo.Url`'s password): its value is redacted wherever it is logged. |

A module location (`declaredBy`, `type.module`) is a registry or URL location
with no `@<version>` and no `#<pin>`, or — for a module on the filesystem — its
path relative to the application's directory, prefixed `./`; a module's
`telo.yaml` is named by its directory, as an import names it. The application
itself is `./`.

A manifest the kernel would refuse has no report: `telo needs report` prints
the refusals instead and exits 1, with nothing on stdout.

## One environment variable per field

Each field of a need is read from exactly one name:

- **Bound** — the application's own need may name it with `env:`
  (`env: { url: DATABASE_URL }`). A bound name replaces the derived one; the two
  are never both read.
- **Derived** — every other field: `TELO_NEED_`, then each segment of the need
  path and the field, in upper case with `_` at its word boundaries, joined by
  `__`. A word boundary falls before an uppercase letter that follows a lowercase
  letter or a digit, and before the last uppercase letter of a run that a
  lowercase letter follows.

| Need path | Field | Variable |
|---|---|---|
| `Orders.databaseAccess` | `url` | `TELO_NEED_ORDERS__DATABASE_ACCESS__URL` |
| `HTTPServer.dbAccess` | `url` | `TELO_NEED_HTTP_SERVER__DB_ACCESS__URL` |
| `sessionKey` | `value` | `TELO_NEED_SESSION_KEY__VALUE` |

Two fields that would read one name — two aliases one word boundary apart, or a
need's name that a `variables:` / `secrets:` / `ports:` entry already binds —
are refused before anything runs (`NEED_ENV_NAME_COLLISION` at `telo check`,
which builds every imported library whole, and `ERR_NEED_ENV_NAME_COLLISION` at
load). Rename an alias or a need, or bind a name with `env:`.

Renaming an import alias or a need moves its derived names: a variable an
operator set for the old path is no longer read, and the report shows the new
one.

## How a need is read

1. **Supplied at an import** — whole or field by field — or, for an
   application's own need, **supplied by name by the parent running it**. Its
   variables are not read, and no host value answers it.
2. **Otherwise from the environment**, at load, before any resource
   initializes:
   - each set variable is decoded against its field's schema as a root
     variable's is — integers and booleans read as such, an object or array as
     JSON, a host path resolved against the working directory. A value that does
     not decode is refused with the application's other input failures, as one
     `ERR_MANIFEST_VALIDATION_FAILED` naming the variable; a sensitive field's
     value is never printed;
   - when any variable of a need is set, every required one must be
     (`ERR_NEED_PARTIALLY_SUPPLIED`, naming which are set and which are not);
   - a required need with none set is `ERR_NEED_UNMET`, naming its path, its
     type, the declaring module and every variable to set;
   - an optional need with none set is `null`.
3. **Otherwise asked for**, when `telo run` is at a terminal and those two
   refusals are the only reason the load would fail: each missing required field
   is asked like any other missing input (a sensitive one without echo), its
   answer read as the variable's text would be and delivered only into the need
   — never set as the variable. See
   [Being asked for what is missing](./configuration.md#being-asked-for-what-is-missing).

Once read, a need's variables are hidden from the running application, by
exact name: a controller reading one through `process.env` or `ctx.env` gets
`undefined` and a warning. A need's values reach only the module that declared
it, as `resources.<need>.<field>`.

## Public addresses

An application declares every address it is reached at as a need of a
kernel-declared type naming a port — one address as `Telo.PublicUrl`, a family
of tenant hosts as `Telo.PublicHostPattern` (see
[Writing a need type](/extend/need-types#kernel-declared-address-types)). Its
`Http.Server` mounts name those needs, so the manifest never holds a domain
name; whoever runs it is the **host** of those addresses.

### What a host does

A host serves an application's addresses in one of two modes.

**Report mode** — the host reads the needs and supplies every one. Every kind
of address is servable this way.

1. It reads `telo needs report -o json`. Each address need gives its type,
   `parameters` (`port`, `primary`, `customDomains`) and the variable its field
   is read from.
2. It gives each `Telo.PublicUrl` a URL that collides with no other, routes its
   host to the port and sets `url`. `primary` marks the need it gives its main
   address.
3. It gives each `Telo.PublicHostPattern` a pattern in either form that
   collides with no other, routes every matching host to the port and sets
   `pattern`.
4. It may route further domains — exact, or `*.` wildcards — to the port of a
   `customDomains` need. It supplies nothing for them.

**Template mode** — the host states its naming and the kernel derives each
address.

1. It sets `TELO_HOST_PUBLIC_URL_TEMPLATE`, and
   `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` when it can serve several
   addresses on one port. It reads nothing about the application before boot.
2. It routes each host the kernel announces on `Kernel.PortsResolved` — a
   port entry carries `publicUrls: [{ need, host }]` when a `Telo.PublicUrl`
   names that port — to its port, again on every load.
3. It answers `Telo.PublicUrl` only. A pattern or a `customDomains` need comes
   from the environment, and whoever sets it acts as the host for it.

In both modes the host routes without changing the request (the path
unchanged, `Host` as the client sent it), never routes one hostname and port
to two ports, supplies origins, owns TLS, certificates and DNS, may redirect a
domain instead of routing it, and leaves unsupplied any need it cannot serve —
the load is then `ERR_NEED_UNMET`, naming the variable.

### Deriving addresses from the templates

A `Telo.PublicUrl` whose variable is not set is answered from the two host
values. Each is an `http` or `https` origin with nothing after the host or
port, `{port}` optional in its host; the secondary's host must hold `{label}`,
and the main template must not. Any other value is `ERR_NEED_HOST_VALUE_INVALID`,
naming the variable and never its value. The templates are read only when the
application declares a `Telo.PublicUrl`.

1. **The label** of a need is its name lowercased, `_` written `-`: `admin` is
   `admin`, `admin_api` is `admin-api`.
2. **The base** of a need is the main template with `{port}` replaced by its
   port's number; a main template without `{port}` is one base for every need.
3. **Among the needs sharing a base,** the primary gets the base; with no
   primary there, the only need sharing it gets it.
4. **Every other need** gets the secondary template with `{label}` and
   `{port}` replaced. With no secondary template it is not answered, and is
   `ERR_NEED_UNMET` unless its variable is set.
5. **A derived first label** over 63 octets, or starting or ending with `-`, is
   `ERR_NEED_HOST_VALUE_INVALID`, naming
   `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` and the need.

With `TELO_HOST_PUBLIC_URL_TEMPLATE=https://{port}-s1.example.dev` and
`TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE=https://{label}--{port}-s1.example.dev`,
a primary `site` on port 8080 reads `https://8080-s1.example.dev` and an `admin`
beside it `https://admin--8080-s1.example.dev`. A `Telo.PublicHostPattern` is
never answered from a template. Both host values are hidden from the running
application, as a need's variables are, and an application started with
`App.Instance` does not inherit them.

### Collisions

Before any resource initializes, two address needs no host could route apart
are refused with `ERR_NEED_PUBLIC_URL_COLLISION`, naming both needs, their
ports and the host:

- on one port, two URLs with the same host, or two patterns with the same
  literal suffix in the same form — matching ignores the port;
- on two ports, the same host or pattern on the same effective port (the
  explicit one, or 80 for `http` and 443 for `https`).

`http://localhost:8080` and `http://localhost:8081` on two ports do not
collide. An exact host a pattern on the same port also matches is not a
collision: the server's precedence decides.

### Locally

Set each address need's variable: `TELO_NEED_SITE__URL=http://localhost:8080`,
`TELO_NEED_ADMIN__URL=http://admin.localhost:8080`, and for a pattern
`TELO_NEED_TENANTS__PATTERN=http://*.tenants.localhost:8080` — browsers resolve
`*.localhost` to loopback.

## Durable directories

An application asks for persistent storage on disk as a need of the
kernel-declared type `Telo.DurableDirectory` (see
[Writing a need type](/extend/need-types#kernel-declared-durable-directories)).
Its one field, `path`, is a directory; the application reads it as
`resources.<need>.path`.

### What the application may rely on

- **`size`** — `parameters.size`, a whole number followed by `Mi`, `Gi` or `Ti`
  (`512Mi`, `5Gi`, `1Ti`), default `1Gi`. It is the least the application
  needs: a host may give more, and may refuse a size it cannot give. Nothing
  measures it; a full directory reaches the application as the operating
  system's own error (`ENOSPC`). Any other spelling (`5GB`) is refused before
  the application runs.
- **`access`** — `single-writer` (default) or `shared`.
  - `single-writer`: at most one running instance of the application has the
    directory at any moment, a rollout or a restart included. A host never runs
    two at once over it, and the application may rely on that — SQLite does.
  - `shared`: every instance has the directory at once, on different machines.
    File locking across them is not reliable, so the application coordinates
    its own writes. SQLite is not safe on a `shared` directory.
- **What persists** — the contents survive restarts, reloads, new deployments
  and new versions of the application, for as long as the host keeps the
  storage. The directory is empty the first time. Nothing here is a backup.
- **Usable before it is used** — however the path was supplied, the kernel
  checks that it names a directory the process can write to, and creates it
  when absent: before any resource initializes for one read from its variable
  or the state directory below, when the import initializes for one an import
  supplies field by field, and when it is created for a fulfilment the
  manifest writes. Otherwise it is refused with `ERR_NEED_DIRECTORY_UNUSABLE`,
  naming the need, where the path came from and what was wrong — not a
  directory, not writable, cannot be created — never what the directory holds.

### What a host does

A host supplies a durable directory in one of two ways.

**Per need** — each need gets storage of its own, with its own size and
access. The host reads `telo needs report -o json`, mounts a volume for each
`Telo.DurableDirectory`, and sets the variable the report lists for its `path`
field to the mount (`TELO_NEED_UPLOADS__PATH`, or the name `env:` binds). It
sets no `TELO_HOST_STATE_DIR`. A renamed need gets a new path and a new
variable, so the host sees a need it has no storage for; recovering the old
storage under the new name is the host's job.

**One state directory** — the host sets `TELO_HOST_STATE_DIR` to a directory
it owns for this one application. Every `Telo.DurableDirectory` whose variable
is not set is then the directory `<state dir>/needs/<need path>`, the need path
written `.`-separated (`needs/uploads`, `needs/Orders.uploads`), created at load
when absent. Nothing is stored beside it, so the same state directory gives the
same directories on every restart, reload and redeployment.

A state directory serves exactly one application: two applications sharing
one would read each other's directories. `TELO_HOST_STATE_DIR` is hidden from
the running application, as a need's variables are, and an application started
with `App.Instance` does not inherit it.

### Renamed needs under a state directory

Renaming a need, or the import alias it is reached through, gives it a new
path, and so a new, empty directory. At load, an entry under
`<state dir>/needs/` that no `Telo.DurableDirectory` need of the application
names is an orphan:

- when the load would create a fresh directory while an orphan exists, it is
  refused with `ERR_NEED_ORPHANED` before any resource initializes, naming both
  paths. Move the old directory to the new path to keep its files, or delete it;
- otherwise the orphan is reported as a warning (`NEED_ORPHANED`).

Nothing is moved or deleted automatically.

### Locally

Set the need's variable to a directory — `TELO_NEED_UPLOADS__PATH=./data/uploads`,
read against the working directory — or set the state directory once for
every need:

```bash
TELO_HOST_STATE_DIR=./data telo run ./shop
```

## Needs supplied by a parent

An application started by another with `App.Instance` is a root of its own, and
does not inherit its parent's host values. The parent supplies the child's own
needs by the child's need names, in the two forms an import takes — a `!ref` to
a need or fulfilment of its own, handed over whole, or a map of the need type's
fields:

```yaml
kind: App.Instance
metadata: { name: agent }
source: ../telo.yaml
needs:
  agentState:
    path: !cel "variables.scratch.joinPath('agent-state')"
```

A need supplied this way is answered by that value alone, before the child's
environment variables and before `TELO_HOST_STATE_DIR` or the address templates
would answer it, and a `supply: root` type is accepted. `telo check` follows
the parent's `source:` and refuses, before anything runs, a name the child does
not declare (naming the needs it does), a field its type does not declare or a
literal the type refuses, a required field a map leaves out, a `!ref` to
anything but a need or fulfilment of the child's type, and a need of the parent
stating less than the child's (its version range, its features, a durable
directory's access or size). The child refuses at load what only the values
decide: a required field an expression left out (`ERR_NEED_PARTIALLY_SUPPLIED`)
and a durable directory it cannot use (`ERR_NEED_DIRECTORY_UNUSABLE`, naming the
parent's `App.Instance`). A sensitive
field is redacted in the child as its need type marks it. This is how a test
gives each application it starts storage of its own.

## See also

- [Declaring a need](/learn/declaring-a-need)
- [Configuring an application](/learn/configuration)
- [Diagnostics reference — needs](/reference/diagnostics#needs)
