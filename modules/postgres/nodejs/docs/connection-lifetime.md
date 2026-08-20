# Connection lifetime

A pooled connection can stop working at any moment, for reasons the application
never sees: the server restarts or fails over, an administrator terminates the
backend, a load balancer or NAT device evicts an idle flow, a route is
blackholed, the host disappears. The module's job is to make every one of those
end the same way — **the connection is replaced, and the application keeps
serving**.

That splits into two problems, because the causes above divide cleanly into ones
that announce themselves and ones that do not.

## When the disconnect is reported

A graceful close arrives as a FIN, and the driver turns it into an error on the
connection. Nothing needs to detect anything; the pool discards that connection
and opens a new one on next demand.

The only requirement is that the error must not be able to take the process down
— and on Node it can. `pg` emits `'error'` on an `EventEmitter`, and `pg-pool`
detaches its own listener for the entire window a connection is checked out
(`_acquireClient` removes it, `_release` puts it back). An ordinary disconnect
during a query therefore reaches an emitter with no listener, and Node throws
`Unhandled 'error' event`, killing the pod. The controller attaches two
listeners — one on the pool for idle connections, one per client via the pool's
`connect` event, which survives `pg-pool`'s add/remove cycle.

Those listeners only report. The in-flight query is rejected separately by the
driver (`_errorAllQueries`), so the caller still sees the failure as a normal
error; nothing is swallowed.

## When it is not reported

An evicted NAT mapping, a blackholed route or a vanished host produces no FIN,
no RST and no event. The socket looks perfectly healthy and stays that way until
something is written to it — which, without a probe, means the discovery is made
by a user request, and that request fails.

The only way to learn about a connection nobody is talking about is to send
something. `pool.healthCheckMs` (default 60s) sweeps on an interval, issuing one
`SELECT 1` per idle connection; a dead one rejects and is evicted. Each sweep
additionally opens however many connections it takes to reach `pool.min` —
`pg-pool` never opens connections on its own, so after a disconnect the pool
would otherwise sit below `min` until traffic arrived, and a `min` declared for
warm capacity would quietly stop holding. Connections that are checked out are
not probed: a busy connection is proving itself. Setting the interval to `0`
disables probing.

Each probe carries its own deadline, equal to the interval. This matters more
than it looks: a probe sent into a blackholed socket does not fail, it waits out
the TCP retransmit window — minutes — and a sweep will not begin another pass
while one is outstanding. Without the deadline, the single case the sweep exists
to catch would be the case that switches it off.

The sweep starts from `init()`, once the connection has proved it works, and
stops in `teardown()`. A recurring probe is a side effect, and a resource whose
`init()` throws is never torn down, so starting it during construction would
leave a timer nobody owns.

`pool.maxLifetimeMs` is the cause-agnostic backstop: retiring connections on a
schedule bounds how long any connection can have been broken without anyone
noticing, including for reasons neither mechanism anticipates.

## What remains

A connection that dies *while a statement is in flight* fails that statement.
This is not an implementation gap — `Connection terminated unexpectedly` does not
say whether the server received and ran the statement, so retrying it
transparently could apply a write twice, and inside a transaction the session is
gone entirely. Deciding a statement is safe to repeat is the author's call, and
it belongs in a declarative `retry` at the manifest level, not inside the driver.

## Contract for other runtimes

This module is Node-specific only in its mechanics. Any implementation — Rust,
Go, another host — must hold the same invariant:

1. **A connection failing must never terminate the process.** It surfaces as a
   failed operation, and only to the caller that was using it. Idle-connection
   failures are reported at `debug` and affect nobody. Most pool libraries give
   this for free; Node's `EventEmitter` does not, which is the only reason
   `handleDisconnects` exists.
2. **A dead connection must be replaced before an operation depends on it**,
   whatever killed it and whether or not anything reported it. Pool *sizing*
   (`min`/`max`) is a capacity decision by the author and must never be used as
   the health mechanism.
3. **Liveness must be established without a report**, on the `healthCheckMs`
   interval, with each probe bounded by a deadline so a hung probe cannot
   suspend the mechanism. Go's `pgxpool` has `HealthCheckPeriod` natively;
   Rust's `sqlx` has its reaper and `test_before_acquire`; Node implements the
   sweep in the controller. Any of these satisfies the contract as long as the
   interval is the one the manifest declares.
4. **`maxLifetimeMs` retires connections on schedule** — `max_lifetime` in
   `sqlx`, `MaxConnLifetime` in `pgxpool`, `maxLifetimeSeconds` in `pg-pool`.

The manifest is the shared surface: `healthCheckMs` and `maxLifetimeMs` mean the
same thing in every runtime, and connection-level transport settings (TLS via
`sslmode`, and libpq's `keepalives*` / `connect_timeout`) stay in the
`connectionString`, where they already have one standard spelling every
PostgreSQL driver understands.
