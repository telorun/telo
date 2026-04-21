# Telo Standard Library

Here you can find standard Telo modules ready to use by the kernel. Each module is self‑contained and declared by its own manifest, resources, and definitions.

## How Modules Fit Together

Modules own specific **resource kinds**. A kernel manifest composes multiple modules into one host, and execution is routed by Kind to the owning module. This keeps the system modular and lets teams add or replace capabilities without changing the core kernel.

For a full explanation of how modules are defined, imported, and composed, see the [Module Specification](../kernel/docs/modules.md).

## Included Modules

| Module | Description |
| ------ | ----------- |
| [**assert**](./assert/docs/manifest.md) | Assertion and value verification for testing (`Assert.Schema`) |
| [**benchmark**](./benchmark/README.md) | Load benchmarking for any invocable Telo resource |
| [**config**](./config/README.md) | Environment variables, secrets, and composed config via `Config.*` |
| [**console**](./console/README.md) | Console I/O via `Console.WriteLine` and `Console.ReadLine` |
| [**http-client**](./http-client/README.md) | Outgoing HTTP calls via `Http.Request` and `Http.Client` |
| [**http-server**](./http-server/README.md) | HTTP server and routing via `Http.Server` and `Http.Api` |
| [**javascript**](./javascript/README.md) | Inline JavaScript execution via `JavaScript.Script` |
| [**run**](./run/docs/structured-errors.md) | Unified sequence execution with invoke, if, while, switch, and try steps |
| [**s3**](./s3/docs/bucket.md) | S3-compatible object storage |
| [**sql**](./sql/README.md) | SQL database access for PostgreSQL and SQLite via `Sql.Connection`, `Sql.Query`, `Sql.Exec`, `Sql.Select`, and `Sql.Transaction` |
| [**sql-repository**](./sql-repository/README.md) | Domain-shaped CRUD over a table via `SqlRepository.Read/Create/Delete` |
| [**starlark**](./starlark/README.md) | Deterministic, bounded scripting via `Starlark.Script` |
| [**test**](./test/docs/suite.md) | Test runner for YAML-based test suites |
| [**tracing**](./tracing/README.md) | Kernel event export via `Tracing.Provider` + exporters |
| [**type**](./type/README.md) | Named data types via `Type.JsonSchema` |
| [**workflow**](./workflow/README.md) | Workflow orchestration primitives with pluggable backends |
| [**workflow-temporal**](./workflow-temporal/README.md) | Temporal backend for `Workflow.Graph` |
