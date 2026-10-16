---
description: "Provision what an application needs before starting it: read the needs report, set one environment variable per field, and know how each variable is named, read and checked."
---

# Providing needs

An application, and every library it imports, may declare **needs** — typed
requests for something it cannot create itself, such as the address and
credentials of a database (see [Declaring a need](/learn/declaring-a-need)).
A need that no import supplies reaches the application being run, and is read
from the environment when it loads. That is the only door: nothing is fetched,
provisioned or asked of a host at boot.

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
| `type.module`, `type.name` | The need type: the module declaring it, and its name there. A type's identity does not depend on the module's version. |
| `version` | The version range the fulfilment must be within (`>=16.0.0`), or `null` when the need states none. A consumer of the need reports the real version and the kernel refuses one outside it with `ERR_NEED_UNMET`, naming the variable it was read from. |
| `features` | The features the fulfilment must carry, `[]` when it asks for none. Checked the same way. |
| `parameters` | What the need asks of its fulfilment, as the need type's `parameters` schema admits — `{}` when it states none. |
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

1. **Supplied at an import** — whole or field by field. Its variables are not
   read, and it is not in the report.
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

Once read, a need's variables are hidden from the running application, by
exact name: a controller reading one through `process.env` or `ctx.env` gets
`undefined` and a warning. A need's values reach only the module that declared
it, as `resources.<need>.<field>`.

## See also

- [Declaring a need](/learn/declaring-a-need)
- [Configuring an application](/learn/configuration)
- [Diagnostics reference — needs](/reference/diagnostics#needs)
