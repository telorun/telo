# Telo Standard Library

The Telo standard library is the collection of modules that ship with the kernel — ready-to-import building blocks for AI, HTTP, storage, workflow orchestration, encoding, runtime targets, scripting, and ops. Each module is self-contained, declared by its own `telo.yaml`, and composes into your application through `Telo.Import`.

For how modules are defined, imported, and composed, see the [Module Specification](../kernel/docs/modules.md).

## Modules by domain

### AI

| Module | Description |
| --- | --- |
| [ai](./ai/README.md) | LLM access via `Ai.Model`, `Ai.Text` (buffered), and `Ai.TextStream` (streaming). |
| [ai-openai](./ai-openai/README.md) | OpenAI provider implementing `Ai.OpenaiModel`. |

### HTTP & APIs

| Module | Description |
| --- | --- |
| [http-server](./http-server/README.md) | Language-agnostic HTTP server and routing (`Http.Server`, `Http.Api`). |
| [http-client](./http-client/README.md) | Outgoing HTTP calls (`Http.Client`, `Http.Request`). |
| [mcp-server](./mcp-server/README.md) | Model Context Protocol server transports and tool bundles. |
| [mcp-client](./mcp-client/README.md) | MCP client transports plus `tools/call` and `tools/list` dispatch. |

### Storage & Data

| Module | Description |
| --- | --- |
| [sql](./sql/README.md) | PostgreSQL and SQLite via `Sql.Connection`, `Sql.Query`, `Sql.Exec`, `Sql.Select`, `Sql.Transaction`, and migrations. |
| [sql-repository](./sql-repository/README.md) | Domain-shaped CRUD over a table via `SqlRepository.Read/Create/Delete`. |
| [s3](./s3/README.md) | S3-compatible object storage. |
| [type](./type/README.md) | Named data types via `Type.JsonSchema`. |
| [yaml](./yaml/README.md) | YAML parsing primitives. |

### Workflow & Control Flow

| Module | Description |
| --- | --- |
| [run](./run/README.md) | Unified sequence execution with invoke, if, while, switch, and try steps. |
| [workflow](./workflow/README.md) | Workflow orchestration primitives with pluggable backends. |
| [workflow-temporal](./workflow-temporal/README.md) | Temporal backend for `Workflow.Graph`. |

### Encoding & Streams

| Module | Description |
| --- | --- |
| [codec](./codec/README.md) | `Codec.Encoder` and `Codec.Decoder` abstracts. |
| [plain-text-codec](./plain-text-codec/README.md) | UTF-8 plain-text encoder and decoder. |
| [ndjson-codec](./ndjson-codec/README.md) | Newline-delimited JSON encoder. |
| [sse-codec](./sse-codec/README.md) | Server-Sent Events encoder. |
| [octet-codec](./octet-codec/README.md) | Raw byte encoder and decoder. |
| [record-stream](./record-stream/README.md) | Record stream primitives. |

### Runtime Targets

| Module | Description |
| --- | --- |
| [lambda](./lambda/README.md) | Run your manifest as an AWS Lambda function (`Lambda.Function`, `Lambda.HttpApi`, `Lambda.Sqs`, `Lambda.Direct`). |

### Scripting

| Module | Description |
| --- | --- |
| [javascript](./javascript/README.md) | Inline JavaScript execution via `JavaScript.Script`. |
| [starlark](./starlark/README.md) | Deterministic, bounded scripting via `Starlark.Script`. |

### Configuration & Ops

| Module | Description |
| --- | --- |
| [config](./config/README.md) | Environment variables, secrets, and composed config via `Config.*`. |
| [console](./console/README.md) | Console I/O via `Console.WriteLine` and `Console.ReadLine`. |
| [benchmark](./benchmark/README.md) | Load benchmarking for any invocable Telo resource. |

### Testing

| Module | Description |
| --- | --- |
| [assert](./assert/README.md) | Assertion and value verification for testing. |
| [test](./test/README.md) | Test runner for YAML-based test suites. |
