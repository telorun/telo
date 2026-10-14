# Changelog

## 0.2.0 - 2026-10-14
### Added
* New module. Docker.Engine implements Container.Engine over the Docker Engine API 1.41 as raw HTTP, over a unix socket, tcp:// or http(s):// with an optional path prefix, sending a bearer token when one is given. It sends a small fixed set of requests (ping, image inspect and pull, container create, start, inspect, logs, list by label and forced delete), binds every published port on the engine's loopback interface to a port the engine chooses, and reads a port's address only from the binding inspect reports.
