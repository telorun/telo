# Connection lifetime — Node mechanics

How this module's Node implementation holds the invariant in
[connection lifetime](../../docs/connection-lifetime.md). Everything here is
`pg` / `pg-pool` specific; another runtime holds the same contract by other
means.

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

The sweep starts from `init()`, once the connection has proved it works, and is
stopped by the inverse `init()` returns alongside it. A recurring probe is a
side effect, and an `init()` that throws part-way recovers what it already
allocated, so starting the timer during construction would leave one nobody
owns.

`pool.maxLifetimeMs` maps straight onto `pg-pool`'s `maxLifetimeSeconds`.
