# Testing a manifest

Two tests over one app, and the structure that makes both possible.

```
cart/          Telo.Library — the pricing rule, exported as an instance
api/           Telo.Library — the route over it, exported as an instance
telo.yaml      Telo.Application — mounts the route on a port
tests/         one manifest per test
test-suite.yaml
```

## Run

```sh
telo ./examples/testing-a-manifest/test-suite.yaml
```

Each test manifest runs in its own kernel, a few at a time, so nothing leaks
between them — no shared port, no shared database, no ordering to get right.

To run the app itself:

```sh
telo ./examples/testing-a-manifest
curl -s -XPOST localhost:8078/cart/price -H 'content-type: application/json' \
  -d '{"items":[{"sku":"cap","unitCents":2500,"quantity":2}]}'
```

## Why the app is two libraries

An application cannot be imported — it is a root, run directly. So anything a
test needs to reach has to live in a `Telo.Library` and be listed in
`exports.resources`. That is not a testing workaround; it is the same seam that
lets a second application mount the same route.

Splitting the rule from the route is what keeps the unit test honest:
`tests/prices-a-cart.yaml` imports `cart/` alone, so it cannot accidentally
depend on a server, a port or a request shape. `tests/serves-the-api.yaml`
imports `api/`, because the thing it asserts *is* the mapping between a request
and the rule.

## Why the integration test owns its server

The server is declared in the test sequence's `with:` block. A `with:` scope is
created when the sequence starts and torn down when it ends, so:

- the port is bound for exactly the length of the test, and freed after it;
- the run exits on its own — nothing holds the process open once the sequence
  returns;
- two tests can each stand up a server without coordinating, because neither
  outlives its own sequence.

## What the assertions look like

`Assert.Equals` compares a whole result against a literal, rather than probing
one field at a time. A field that appears, disappears or changes type fails the
test where it happens. The boundary case (a subtotal exactly at the discount
threshold) is asserted deliberately — that is the value a wrong comparison
operator gets wrong, and the one a happy-path test never reaches.
