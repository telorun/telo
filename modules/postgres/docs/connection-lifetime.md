# Connection lifetime

A pooled connection can stop working at any moment, for reasons the application
never sees: the server restarts or fails over, an administrator terminates the
backend, a load balancer or NAT device evicts an idle flow, a route is
blackholed, the host disappears. The module's job is to make every one of those
end the same way — **the connection is replaced, and the application keeps
serving**.

## Two failure modes

The causes divide cleanly into ones that announce themselves and ones that do
not, and only the first is free.

A graceful close arrives as a FIN and the driver turns it into an error on the
connection: the pool discards it and opens a new one on next demand. Nothing
needs to detect anything — the only requirement is that the failure must not be
able to take the process down.

An evicted NAT mapping, a blackholed route or a vanished host produces no FIN,
no RST and no event. The socket looks perfectly healthy and stays that way until
something is written to it — which, without a probe, means the discovery is made
by a user request, and that request fails. The only way to learn about a
connection nobody is talking about is to send something: `pool.healthCheckMs`
(default 60s) probes idle connections on an interval and evicts the ones that
reject, and `pool.maxLifetimeMs` retires connections on a schedule as a
cause-agnostic backstop for whatever neither mechanism anticipates.

## What remains

A connection that dies *while a statement is in flight* fails that statement.
This is not an implementation gap — `Connection terminated unexpectedly` does not
say whether the server received and ran the statement, so retrying it
transparently could apply a write twice, and inside a transaction the session is
gone entirely. Deciding a statement is safe to repeat is the author's call, and
it belongs in a declarative `retry` at the manifest level, not inside the driver.

## Contract for other runtimes

Any implementation — Node, Rust, Go, another host — must hold the same
invariant. The Node mechanics, and why `pg` makes the first point harder than
it looks, are in [the Node implementation notes](../nodejs/docs/connection-lifetime.md).

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
