# Telo Engine Specification: Telemetry & Observability

## 1. Core Principles

The Telo engine treats Observability (Logging, Tracing, and Metrics) as a cross-cutting concern, fundamentally distinct from business logic (Signals). To maintain a clean dependency graph (DAG) and zero-boilerplate YAML, Telo employs **Ambient Context Injection** and adheres strictly to **OpenTelemetry (OTel)** standards.

- **No Explicit Wiring:** Business modules do not declare telemetry inputs or outputs in their `exports` or `dependsOn` blocks.
- **Cascading Sinks:** Telemetry Providers are defined at the root level. The engine implicitly cascades these sinks down the execution graph into the context of every running resource.
- **Standardized Payloads:** Telo does not invent custom logging formats. It natively adopts OpenTelemetry Semantic Conventions for all telemetry payloads.

## 2. Ambient Context Injection (YAML API)

End-users enable observability by declaring a Telemetry Provider at the highest level of their application (typically the root module).

The Telo engine detects the `Telemetry` trait of this Provider and automatically attaches it to the execution context (`ctx`) of all downstream `Runnable` and `Invokable` resources.

**Syntax (`root-telo.yaml`):**

```yaml
kind: Kernel.Application
metadata:
  name: main-application

targets:
  - "${{ resources.MainApi }}"

---
# Global Telemetry Sink: Automatically cascades to all imported modules and resources.
kind: OpenTelemetry.Tracer
metadata:
  name: GlobalTracer
config:
  endpoint: "http://otel-collector:4317"
  protocol: grpc

---
kind: Kernel.Import
metadata:
  name: Users
source:
  module: users-module # Resources inside here will implicitly log to GlobalTracer
```

## 3. Dual-Layer Instrumentation Architecture

To ensure high-quality, searchable observability data without burdening standard library developers, Telo divides telemetry responsibilities into two layers:

### Layer 1: Engine Automated Instrumentation (The Orchestrator)

The Telo engine core wraps the execution of every resource (`Run`, `Init`, `Invoke`) with automated tracing. Without a single line of code from the resource developer, the engine automatically records:

- **Trace context generation:** Trace ID, Span ID, and Parent ID propagation.
- **Execution boundaries:** Start time, end time, and total duration.
- **Node Metadata:** Resource name, Resource kind, and Module path (e.g., `telo.resource.kind = "Postgres.Query"`, `telo.module = "users-module"`).
- **Error Interception:** Automatically marking spans as `Failed` and attaching stack traces if an `Invoke()` or `Run()` returns an error.

### Layer 2: Resource-Level Domain Context (The Standard Library)

The engine cannot know the specific domain logic of a resource (e.g., SQL queries, HTTP routes). Therefore, resource developers enrich the engine-created spans using the `TelemetryContext` API, strictly adhering to OTel Semantic Conventions.

## 4. Standard Library Contract (Internal SDK)

Resource handlers interact with the injected telemetry sink via the `Context` object provided by the engine. If no Telemetry Provider was declared in the root YAML, these calls safely resolve to a no-op (void), ensuring zero runtime panics.

**Example Internal Implementation (Go):**

```go
// Inside a Standard Library Handler (e.g., Http.Api)
func (api *HttpApiHandler) Run(ctx telo.Context) error {
    // The engine has already started a span for this resource.
    // We enrich it with domain-specific OTel Semantic Conventions.

    // Example: Recording an HTTP request
    ctx.Telemetry().RecordEvent("HTTP Request Received", map[string]interface{}{
        "http.method":      "POST",
        "http.route":       "/users",
        "http.status_code": 201,
        "net.peer.ip":      "192.168.1.5",
    })

    return nil
}

// Inside an Invokable Handler (e.g., Postgres.Query)
func (q *PostgresQueryHandler) Invoke(ctx telo.Context, args map[string]interface{}) (interface{}, error) {
    // Enriching the automated engine span with Database conventions
    ctx.Telemetry().SetAttributes(map[string]interface{}{
        "db.system":    "postgresql",
        "db.statement": q.config.SQL,
        "db.user":      q.config.User,
    })

    // Execute query...
    return result, nil
}

```

## 5. Adopted Semantic Conventions

To ensure compatibility with APM tools (Datadog, Grafana, Jaeger), Telo standard library modules must use official OTel keys. Common namespaces include:

- `http.*` (e.g., `http.method`, `http.status_code`, `http.url`)
- `db.*` (e.g., `db.system`, `db.statement`, `db.operation`)
- `messaging.*` (e.g., `messaging.system`, `messaging.destination`)
- `telo.*` (Custom engine namespace for DAG-specific metadata like graph paths and node execution states).
