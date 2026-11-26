# The record contract

What a [`Ui.Query`](query.md)'s `url` speaks: one record read when a page is
drawn. Any route that speaks it can feed a query — an `Http.Api` route, a
proxy, a static file.

## The request

```
GET <url path>?<param>=<value>&…
Accept: application/json
```

A query with an `input` sends a JSON body instead, as `QUERY` (the default) or
`POST`:

```
QUERY <url path>?<param>=<value>&…
Content-Type: application/json
Accept: application/json

<the body>
```

A `QUERY` is answered exactly as a `GET` is — the same statuses, the same
bodies, the same problems — and a 400 for the body carries its issues at
`/body/…`. Everything below holds for all three methods.

- `<url path>` is the query's `url` [expanded](nodes.md#addresses):
  app-relative, so a renderer mounted under a prefix reads it under that
  prefix, with each `{name}` segment filled from `pathParams`. A path variable
  that holds nothing leaves the read unsent.
- Each of `url.queryParams` that holds a value is sent as one query
  parameter: a string as written, a number or a boolean as its text, a list
  repeating its key. A parameter whose value is missing is not sent.
- Credentials of the page's own origin travel with it, as for every request a
  renderer makes.

## The answer

| Status | Body | Drawn |
| --- | --- | --- |
| 2xx | a JSON object valid against the query's `model` | the node's `children`, over `data` |
| 2xx | anything else — not JSON, not an object, or refused by the model's keywords in the [interpreted profile](conditions.md#the-interpreted-profile) | `failure`, `error.code` `ERR_UI_RESPONSE_INVALID` |
| 401, 403 | optionally a problem | `failure`; without a `code`, `error.code` is `ERR_UI_UNAUTHORIZED` / `ERR_UI_FORBIDDEN` |
| anything else | optionally a problem | `failure`, `error.code` `ERR_UI_REQUEST_FAILED` when the body names none |
| no answer at all | — | `failure`, `error.status` absent, `error.code` `ERR_UI_REQUEST_FAILED` |

`error` is a `Ui.RequestError`: `status` the response's status, `code` the
problem body's `code` (RFC 9457, `application/problem+json`, what an `Http.Api`
answers every error with) and `message` its `detail`; without a `detail`,
`message` is `ui`'s own text for the status. Keywords of the model
outside the profile are left to the API.

A record answered with an `ETag` (a strong validator, quoted) is guarded: the
renderer keeps it for the request path and sends it as `If-Match` with the next
`PATCH`, `PUT` or `DELETE` to that path, as the [mutation contract](mutation-contract.md#preconditions)
says. A read answered with none leaves nothing kept.

A 401 or 403 to a request made *inside* the children of a query node — a listing's page, a form's
save — is shown where it happened, not by the query; with `reloadOn:
[unauthorized]`, a 401 there also makes the query read again.
