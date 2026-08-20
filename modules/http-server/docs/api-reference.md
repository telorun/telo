# API reference docs

`Http.Server` describes itself: declaring `openapi:` collects an OpenAPI document
from every mounted route's request and response schemas. `Http.Reference` is what
serves that document — a `Telo.Mount` like any other, attached under the prefix
you give it.

```yaml
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
openapi:
  info:
    title: Todo API
    version: 1.0.0
mounts:
  - path: /v1
    mount: !ref api
  - path: /docs
    mount: { kind: Http.Reference }
```

Three routes appear under the mount's prefix:

| Path | Serves |
| --- | --- |
| `/docs/` | the browsable reference page |
| `/docs/openapi.json` | the OpenAPI document, JSON |
| `/docs/openapi.yaml` | the OpenAPI document, YAML |

## Why the document and the page are separate

The document is collected server-wide — a route's schema is read as it registers,
so collection has to be in place before any mount attaches. The page is just a
reader of that document, and where it lives is an application decision. Keeping
them apart is what makes the prefix yours, and what makes leaving the docs out of
a deployment a one-line change rather than a fork of the server.

A reference mounted on a server that declares no `openapi:` block is a
`telo check` error — reported on the *server*, at the mount slot that reaches the
reference, because that is the resource whose author can fix it:

```
app.yaml:35:5  error  Http.Server/server at 'mounts[1].mount': required by
Http.Reference — mounts an Http.Reference, but declares no `openapi:` block, …
REFERRER_RULE_VIOLATED
```

`Http.Reference` declares that as a [referrer
rule](../../../docs/extend/referrer-rules.md): the requirement is the mount's, so
the server needs no knowledge of which mounts need what. The controller keeps its
own guard, so the same mistake reached through a path `telo check` never saw
still fails at startup, before the port is bound, rather than serving an empty
page.

## Leaving the docs out of production

A mount entry takes `when:`, evaluated once at startup with the rest of the
server's configuration. A mount left out registers nothing at all, so its prefix
answers 404 exactly as if it had never been declared:

```yaml
variables:
  env:
    env: APP_ENV
    type: string
    default: development
---
kind: Http.Server
# …
mounts:
  - path: /v1
    mount: !ref api
  - path: /docs
    mount: { kind: Http.Reference }
    when: !cel "variables.env != 'production'"
```

`when:` is general — it belongs to the mount entry, not to this kind, so an admin
router or a debug endpoint is gated the same way.

The gate is about reachability, not about what ships: the resource is still
created and initialized, and the module's code is still in the artifact. What
changes is that nothing is routed to it.

## Options

| Field | Purpose |
| --- | --- |
| `title` | Browser page title. Defaults to the API title from the server's `openapi.info`. |
| `theme` | Colour preset for the reference page. |

## Behind a proxy

The document's `servers[]` entry follows the server's own configuration — an
explicit `baseUrl`, else per-request forwarded headers when
`trustForwardedHeaders` is on, else the relative `/`. See §5 of the module README
for the full table. The per-request rewrite is applied by whichever reference
mount serves the document, since that is the side that knows its path.
