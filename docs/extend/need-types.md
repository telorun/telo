---
sidebar_label: Need Types
slug: /extend/need-types
description: "Declare what a module can ask its host or importer for — the fields a fulfilment hands over, which are required and sensitive, the parameters a need may state, and whether fulfilments are versioned or carry features — with a Telo.NeedType."
---

# Writing a need type

A **need type** describes something a module can ask for: the fields a
fulfilment of it hands over, which of them are required, and what a need may
state about it. Any library may declare and export one; Telo owns no list.

```yaml
kind: Telo.Library
metadata: { name: Postgres }
exports:
  kinds: [DatabaseAccess]
---
kind: Telo.NeedType
metadata:
  name: DatabaseAccess
  description: The address and credentials of one database.
fields:
  url: { type: string, x-telo-sensitive: true }
  schema: { type: string }
required: [url]
version: semver
features: [pgvector, postgis]
parameters:
  type: object
  properties:
    size: { type: string }
  additionalProperties: false
```

| Key | What it declares |
| --- | --- |
| `fields` | A JSON Schema property map: what every fulfilment hands over. |
| `required` | The fields every fulfilment must yield. A name that is not a field is `NEED_FIELD_UNDECLARED`. |
| `parameters` | The JSON Schema of the literal `parameters:` a need may state. A need of a type with none states none. |
| `version` | `semver` when fulfilments are versioned. Only then may a need state a `version:` range. |
| `features` | The closed list of feature names a fulfilment may carry. A need may ask for a subset. |

The document registers the kind `<Module>.<Name>` — `Postgres.DatabaseAccess`
here — exported through `exports.kinds` and gated like any other kind. A
need type has no `extends`.

## What the kind is

A resource of the kind is a **fulfilment**. Its capability is `Telo.Provider`, so
every field is evaluated at startup and readable at startup, it takes part in
the init order, and no `targets:` entry accepts it. It is served by the kernel's
one need-type controller, so a need type ships no controller of its own, and its
published reading is exactly its fields — which is what `resources.<name>` is
typed from, closed to the fields the type declares.

A fulfilment the module writes itself holds its values under `fields:`. The
kind's schema is closed: `fields` takes exactly the type's fields, requires
its required ones, and is itself required when the type requires a field, so an
editor offers only the declared fields and marks the required ones. A key the
type does not declare is `NEED_FIELD_UNDECLARED` and a missing required field
`NEED_SLOT_MISMATCH`, each reported once.

```yaml
kind: Postgres.DatabaseAccess
metadata: { name: mainDatabase }
fields:
  url: postgres://localhost:5432/main
```

The kind carries the document's `metadata` as written: a `description` and
`categories` describe it like any kind's, and `metadata.deprecated` makes
declaring a fulfilment of it a `DEPRECATED_KIND` warning.

Every need is bound at load to one fulfilment: one the importer hands down whole,
one built from an import's field-by-field supply, or one the module writes
itself. See [Declaring a need](/learn/declaring-a-need).

## Versions and features

`version: semver` and `features:` let a need say more than which fields it wants:
`version: ">=15.0.0"` (a conjunction of explicit comparators — the `requires:`
grammar, with no `^`, `~`, `||` or bare version) and
`features: [pgvector]`. A need stating either on a type that does not declare it,
a range outside the grammar or a feature the type does not list is
`NEED_PARAMETERS_INVALID`.

A stated constraint is a claim about the real thing behind the fulfilment, so
something must check it: a kind that opens the fulfilment declares an observing
slot (`observes: [version, features]`), reports what it found, and the kernel
compares. A constraint no observing slot can reach is refused
(`NEED_CONSTRAINT_UNVERIFIED`). A pure provisioning request — a disk size, a
region — is a `parameters` field, which nothing has to observe. See
[A kind that consumes and verifies a need](./consuming-needs.md).

## Sensitive fields

A field marked `x-telo-sensitive: true` holds a credential. Its value joins the
redaction set of the module context that owns the fulfilment and of every
module context bound to it, so it is printed as `[redacted]` wherever a log
line carries it, exactly as a `secrets:` value is. Redaction replaces the
value's text, so the mark must be `true` and the field must hold text — `type:
string`, or a value type written as its text such as `Telo.Url`
(`SENSITIVE_ANNOTATION_INVALID` otherwise — reported in an importer's check at
the import that reaches the library, and refused at load as
`ERR_SENSITIVE_ANNOTATION_INVALID`).

A field typed `Telo.Url` needs no mark to keep its credentials out of logs: the
type declares its `password` member sensitive, so a URL holding one has its
password and its whole text redacted the same way, the field is listed
sensitive by `telo needs report`, and `ctx.resolveNeed` marks it sensitive
whenever the value holds a password. Its `host` stays readable. Restrict the
scheme with the type's `scheme` argument:

```yaml
fields:
  url:
    x-telo-type: { name: Telo.Url, scheme: { enum: [postgres, postgresql] } }
```

A fulfilment writes such a field as the URL's text or as an object of its members
(`scheme`, `host`, `port`, `user`, `password`, `path`, `query`), which the type
escapes; a value it refuses is `URL_INVALID`, or `ERR_URL_INVALID` once an
expression produces it.

## Naming a need type

A need type is named for what its fulfilment hands over. It is
`<Thing>Access` when that is the address and credentials of something outside
the application, `<Thing>` being the exact unit the credentials are scoped to —
`DatabaseAccess`, `ServerAccess`, `BucketAccess`, `ApiAccess`. It is the bare
noun when the fulfilment is the thing itself on the host. The name of the object
itself stays free for a kind that creates or owns it.

## See also

- [Declaring a need](/learn/declaring-a-need)
- [A kind that consumes and verifies a need](./consuming-needs.md)
- [Style guide](/learn/style-guide)
- [Diagnostics reference — needs](/reference/diagnostics#needs)
