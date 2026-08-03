# Your first HTTP API

[Getting started](/learn/getting-started) printed a line to the console. This
guide builds something you can `curl`: an HTTP endpoint with a validated
request, a typed response, and configuration bound to the environment. About
fifteen minutes.

By the end you will have used every piece an ordinary Telo application is made
of — a service, a router, a handler, references, expressions, and config.

## 1. A server, a router, and a handler

Create `greeting-api/telo.yaml`:

```yaml
kind: Telo.Application
metadata:
  name: GreetingApi
  version: 1.0.0
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref Server
ports:
  http:
    env: PORT
    default: 8080
---
kind: Http.Server
metadata:
  name: Server
port: !cel "ports.http"
mounts:
  - path: /v1
    mount: !ref Api
---
kind: Http.Api
metadata:
  name: Api
routes:
  - request:
      path: /greet
      method: GET
    handler: !ref Greet
    returns:
      - status: 200
        content:
          application/json:
            body:
              message: !cel "result.message"
---
kind: Run.Value
metadata:
  name: Greet
value:
  message: Hello!
```

```bash
telo ./greeting-api
curl http://localhost:8080/v1/greet
# {"message":"Hello!"}
```

That is a complete application. Read it top to bottom:

- **`imports:`** pulls in two modules under aliases you chose. Those aliases are
  why the kinds below are written `Http.Server` and `Run.Value` — alias the
  first one `Web` and it would be `Web.Server`.
- **`ports:`** declares that this application listens, bound to the `PORT`
  environment variable with a default, and resolves into the `ports.http` CEL
  scope. `port: !cel "ports.http"` reads it: one declaration, one source of
  truth, and a runner knows the exposed port without starting the app.
- **`targets:`** is the boot sequence — `!ref Server` says "start this".
- **A server does not contain routes.** It **mounts** routers, each under a path
  prefix. That is what makes `Http.Api` reusable and independently testable.
- **A route is three things**: a request matcher, a `handler:` reference, and a
  `returns:` block mapping the handler's result into a response. Inside
  `returns:`, `result` *is* what the handler produced.
- **`Run.Value`** is the simplest possible handler: it returns a shaped value
  and nothing else.

The server stays up after it starts — a `Telo.Service` holds the process open
until you stop it. Ctrl-C tears everything down in order.

## 2. Read something from the request

Declare what the request must contain, and map it into the handler's inputs:

```yaml
routes:
  - request:
      path: /greet
      method: GET
      schema:
        query:
          type: object
          properties:
            name: { type: string }
          required: [name]
    handler: !ref Greet
    inputs:
      name: !cel "request.query.name"
    returns:
      - status: 200
        content:
          application/json:
            body:
              message: !cel "result.message"
```

Two payoffs from that `schema:` block:

1. **Validation is free.** A request without `?name=` is rejected with a 400
   before your handler is reached — you write no checking code.
2. **CEL knows the shape.** `request.query.name` type-checks. Misspell it as
   `request.query.nmae` and `telo check` fails with `CEL_UNKNOWN_FIELD`.

Now give the handler a contract and use the input:

```yaml
kind: Run.Value
metadata:
  name: Greet
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      name: { type: string }
    required: [name]
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      message: { type: string }
    required: [message]
value:
  message: !cel "'Hello, ' + inputs.name + '!'"
```

`inputType` and `outputType` are **schemas**; `inputs` and `value` are
**values**. That distinction holds everywhere in Telo, with no exceptions.

Declaring `outputType` is what makes `result.message` in the route type-check —
and it is enforced at runtime too, so a handler that returns the wrong shape
fails with `ERR_OUTPUT_INVALID` rather than serving nonsense.

## 3. Configure it

Anything that differs between environments is declared on the application and
bound to an environment variable:

```yaml
variables:
  greeting:
    env: GREETING
    type: string
    default: Hello
```

and read like any other value:

```yaml
value:
  message: !cel "variables.greeting + ', ' + inputs.name + '!'"
```

Values resolve at load. A required variable that is missing fails the whole
load with a message naming it — not on the first request that needed it. Use
`secrets:` instead of `variables:` for anything sensitive: same shape, but the
values are redacted from logs automatically.

## The finished manifest

```yaml
kind: Telo.Application
metadata:
  name: GreetingApi
  version: 1.0.0
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref Server
ports:
  http:
    env: PORT
    default: 8080
variables:
  greeting:
    env: GREETING
    type: string
    default: Hello
---
kind: Http.Server
metadata:
  name: Server
port: !cel "ports.http"
openapi:
  info:
    title: Greeting API
    version: 1.0.0
mounts:
  - path: /v1
    mount: !ref Api
---
kind: Http.Api
metadata:
  name: Api
routes:
  - request:
      path: /greet
      method: GET
      schema:
        query:
          type: object
          properties:
            name: { type: string }
          required: [name]
    handler: !ref Greet
    inputs:
      name: !cel "request.query.name"
    returns:
      - status: 200
        content:
          application/json:
            schema:
              type: object
              properties:
                message: { type: string }
              required: [message]
              additionalProperties: false
            body:
              message: !cel "result.message"
---
kind: Run.Value
metadata:
  name: Greet
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      name: { type: string }
    required: [name]
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      message: { type: string }
    required: [message]
value:
  message: !cel "variables.greeting + ', ' + inputs.name + '!'"
```

```bash
telo check ./greeting-api          # static: kinds, refs, CEL types
GREETING=Hej telo ./greeting-api

curl 'http://localhost:8080/v1/greet?name=World'
# {"message":"Hej, World!"}

curl -i 'http://localhost:8080/v1/greet'
# HTTP/1.1 400 Bad Request  — the request schema rejected it
```

The `openapi:` block means the server also describes itself — the generated
OpenAPI document covers every route, matcher and response schema you declared,
because they are declarations rather than code.

## What to do next

- **Real logic in the handler** — swap `Run.Value` for `JavaScript.Script` when
  you need code, or a `Run.Sequence` when you need several steps:
  [Composing behaviour](/learn/composing-behaviour).
- **Talk to a database** — search the [standard library](/reference/standard-library)
  for `sql`, or `sql-repository` for table-level CRUD without hand-written SQL.
- **Test it** — [Testing your manifests](/build/testing). Tests are manifests
  too, running on the same kernel.
- **Ship it** — [Deploy](/deploy).
- **Understand what just happened** — [How Telo works](/learn/how-telo-works).
