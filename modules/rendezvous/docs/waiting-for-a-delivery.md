# Waiting for a delivery over HTTP

A client waits for a decision on one request while another request supplies it.
The wait is a long poll: it holds the request until the value arrives or the
timeout passes, and the client asks again.

## The pattern

A point carries the decision's shape. One route awaits under the approval id and
another delivers under the same id:

```yaml
kind: Rendezvous.MemoryPoint
metadata: { name: decisions }
hold: 120s
payloadType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [approved]
    properties:
      approved: { type: boolean }
      note: { type: string }
---
kind: Http.Api
metadata: { name: routes }
routes:
  - request: { path: "/approvals/{id}/decision", method: GET }
    handler: { kind: Rendezvous.Await, point: !ref decisions, timeout: 25s }
    inputs: { key: !cel "request.params.id" }
    returns:
      - { status: 200, content: { application/json: { body: !cel "result" } } }
    catches:
      - when: !cel "error.code == 'ERR_RENDEZVOUS_AWAIT_TIMEOUT'"
        status: 204
      - when: !cel "error.code == 'ERR_RENDEZVOUS_KEY_BUSY'"
        status: 409
        content: { application/problem+json: {} }
  - request:
      path: "/approvals/{id}/decision"
      method: PUT
      schema:
        body:
          type: object
          required: [approved]
          properties:
            approved: { type: boolean }
            note: { type: string }
    handler: { kind: Rendezvous.Deliver, point: !ref decisions }
    inputs:
      key: !cel "request.params.id"
      payload: !cel "request.body"
    returns:
      - { status: 202, content: { application/json: { body: !cel "result" } } }
```

## What a client sees

- `PUT` before any `GET` answers `202 {"delivered": false}`: the decision is held,
  and the next `GET` for that id returns it at once.
- `PUT` while a `GET` waits answers `202 {"delivered": true}` and the `GET`
  returns the decision.
- A `GET` unanswered for 25 seconds answers `204`. Ask again: a decision
  delivered in the gap is held for the next `GET`.
- A second `GET` for an id that already has a waiter answers `409`.

## Client rules

- **Retry on `204`** immediately: it means nothing arrived yet, not an error.
- **Retry on `409`** after a short pause. It happens when a client reconnects
  before the server has seen the old connection close; the old waiter leaves as
  soon as the server notices, and the retry then succeeds.
- Keep the route's `timeout` under every proxy and client deadline in front of
  the server, so the request ends with a `204` rather than a cut connection.
- Keys are unique per meeting (an approval id, a tool-call id, an OAuth `state`).
  A mistyped key delivered while nobody waits reads `delivered: false` and expires
  unobserved after `hold`.
- Choose `hold` for how late a client may start waiting after the delivery.

## Limits

`Rendezvous.MemoryPoint` lives in one process, so with several instances a `GET`
and a `PUT` that land on different ones never meet. Run one instance, route both
requests of an id to the same one, or use a point whose backend reaches across
instances.

A wait cannot run inside a durable run: `telo check` refuses it. Wait there with
`Durable.Await`.
