# Serving a host-supplied socket

A process that embeds the Telo kernel may own a port's socket itself — to put
its own admission in front of every connection, to keep the port confined to
loopback, or to hold a port it picked before the application started. It then
supplies that port's connections to whichever server is configured with its
number. Nothing in the manifest changes: the server's `listen.port` is the
number, and the server serves the host's socket instead of binding.

```yaml
kind: Http.Server
metadata: { name: web }
listen:
  port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref api
```

## What the server does

When it runs, an `Http.Server` asks the kernel whether the host holds a socket
for `listen.port` (the controller protocol's `Listener.Claim`, in Node
`ctx.claimListener`):

- **The host holds one.** The server binds nothing and `listen.address` is not
  used. Every connection the host admits for the port is handed over and served
  as an accepted one — keep-alive, request and header timeouts, the request body
  limit, a WebSocket or other `Upgrade` and TLS (when `tls` is set) behave as on
  a bound socket. The connection begins with the bytes the host already read
  while admitting it, so the first request is read exactly as the client sent
  it. A connection the host admitted before the server started is held by the
  kernel and served once it has.
- **The host holds none.** The server binds `listen.address:listen.port` as
  always.

`http.server.started` and `<server>.Listening` carry the host socket's address
as `server.address` / `address`, and the started record adds
`server.socket.supplied_by: host`.

Stopping the server gives the socket back (`Listener.Release`) before its
connections drain: what the host admits from then on is held until a server
claims the port again. A second server configured with a port another server
has claimed fails to start with `ERR_LISTENER_CLAIMED`, as a second bind of one
port fails with `EADDRINUSE`.

## What the host decides

The host chooses which ports it holds and answers what no server can take: a
connection still unclaimed when startup ends — no server is configured with the
port, or the application failed to start — gets `503` with a body the host
supplies, and the kernel warns, naming the port's key in `ports:`. A port the
host holds is announced on `Kernel.PortsResolved` with `address` and
`suppliedBy: host`.

A child application started with `App.Instance` and handed the port number
serves the host's socket the same way. The kernel's embedding API is
`HostListeners` (`@telorun/kernel`); see `kernel/specs/controller-protocol.md`
§9.4 for the protocol.

## Requires

The module carries a `restrictions:` entry requiring the telo release whose
kernel answers `Listener.Claim`: an older kernel has no `ctx.claimListener`, and
the server would fail to start. Static checking cannot see that need, so it is
stated beside the measured floor rather than as it.
