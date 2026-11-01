# The record contract

What a [`Ui.Data`](data.md)'s `source` speaks: one record read when a page is
drawn. Any route that speaks it can feed a reader — an `Http.Api` route, a
proxy, a static file.

## The request

```
GET <source.path>?<param>=<value>&…
Accept: application/json
```

- `<source.path>` is app-relative: a renderer mounted under a prefix reads it
  under that prefix.
- Each of `source.params` that holds a value is sent as one query parameter: a
  string as written, a number or a boolean as its text. A parameter whose value
  is missing is not sent.
- Credentials of the page's own origin travel with it, as for every request a
  renderer makes.

## The answer

| Status | Body | Drawn |
| --- | --- | --- |
| 2xx | a JSON object valid against the reader's `model` | `content`, over `data` |
| 2xx | anything else — not JSON, not an object, or refused by the model's keywords in the [interpreted profile](conditions.md#the-interpreted-profile) | `failure`, `error.code` `ERR_UI_RESPONSE_INVALID` |
| 401, 403 | optionally a problem | `failure`; without a `code`, `error.code` is `ERR_UI_UNAUTHORIZED` / `ERR_UI_FORBIDDEN` |
| anything else | optionally a problem | `failure`, `error.code` `ERR_UI_REQUEST_FAILED` when the body names none |
| no answer at all | — | `failure`, `error.status` absent, `error.code` `ERR_UI_REQUEST_FAILED` |

`error` is a `Ui.RequestError`: `status` the response's status, `code` the
problem body's `code` (RFC 9457, `application/problem+json`, what an `Http.Api`
answers every error with) and `message` its `detail`; without a `detail`,
`message` is the renderer's own word for the status. Keywords of the model
outside the profile are left to the API.

A 401 or 403 to a request made *inside* the content — a listing's page, a form's
save — is shown where it happened, not by the reader; with `reloadOn:
[unauthorized]`, a 401 there also makes the reader read again.
