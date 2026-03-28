# Telo Standard Library

Here you can find standard Telo modules ready to use by the kernel. Each module is self‑contained and declared by its own manifest, resources, and definitions.

## How Modules Fit Together

Modules own specific **resource kinds**. A kernel manifest composes multiple modules into one host, and execution is routed by Kind to the owning module. This keeps the system modular and lets teams add or replace capabilities without changing the core kernel.

For a full explanation of how modules are defined, imported, and composed, see the [Module Specification](../kernel/modules.md).

## Included Modules

| Module | Description |
|--------|-------------|
| [**assert/**](assert/) | Assertion and value verification for testing (`Assert.Schema`) |
| [**config/**](config/) | Configuration injection via `Config.Variable` and `Config.Secret` resources |
| [**console/**](console/) | Console I/O via `Console.WriteLine` and `Console.ReadLine` |
| [**data/**](data/) | Shared data type definitions (`Data.Type`) |
| [**http-client/**](http-client/README.md) | Outgoing HTTP calls via `Http.Request` and `Http.Client` |
| [**http-server/**](http-server/README.md) | HTTP server and routing via `Http.Server` and `Http.Api` |
| [**javascript/**](javascript/) | Inline JavaScript execution via `JavaScript.Script` |
| [**run/**](run/) | Unified sequence execution with invoke, if, while, switch, and try steps |
| [**sql/**](sql/) | SQL database access for PostgreSQL and SQLite via `Sql.Connection`, `Sql.Query`, `Sql.Exec`, and `Sql.Transaction` |
| [**starlark/**](starlark/) | Starlark scripting within workflows via `Starlark.Script` |
| [**studio/**](studio/README.md) | Foundational resource kinds and definitions used by DiglyAI Studio |
| [**template/**](template/) | Parameterized resource generation via `Template.Definition` |
| [**tracing/**](tracing/) | Distributed tracing support via `Tracing` definitions |
