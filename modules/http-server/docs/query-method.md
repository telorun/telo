# The QUERY method

> Examples below assume the `http-server` module is imported under alias `Http`, and `run` under `Run`.

`QUERY` is the safe, idempotent method that carries a body: a read whose input is a record too large or too structured for a query string. A route declares it as any other method and takes its body the way a `POST` route does.

```yaml
kind: Http.Api
metadata: { name: api }
routes:
  - request:
      path: /report
      method: QUERY
      schema:
        body:
          type: object
          required: [from]
          properties: { from: { type: string, format: date } }
    handler: !ref report
    inputs: { from: !cel "request.body.from" }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
```

A body the schema refuses answers `400` with issues at `/body/…`, exactly as for `POST`.

## What differs from `POST`

- **Nothing in the server.** Routing, body parsing, `maxBodyBytes`, authentication, guards, `returns:` and `catches:` treat `QUERY` as they treat `POST`.
- **The cookie origin check** exempts only `GET`, `HEAD` and `OPTIONS`, so a `QUERY` authenticated by a cookie is checked as a `POST` is ([Authentication and authorization](authentication.md#the-origin-check)).
- **CORS.** The default allowed methods do not include `QUERY`, so a cross-origin `QUERY` needs `cors.methods` to list it, and `trustedOrigins` on the cookie source when the credential is a cookie, as `PUT` does.
- **The OpenAPI document** lists the operation under the path item's `query` key with its request body ([API reference docs](api-reference.md)).

## Intermediaries

A CDN, gateway or firewall that does not know `QUERY` may refuse it or drop its body, and the client then sees a failure the server never produced. Where such an intermediary stands in front of the server, declare the route `POST` and have the client send `POST`.
