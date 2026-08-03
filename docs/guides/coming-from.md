# Coming from somewhere else

Telo looks like configuration and behaves like a runtime, which trips up almost
everyone's first mental model. This page maps the three most common ones onto
it, then answers the questions they generate.

## From a web framework (Express, FastAPI, NestJS, Spring)

The closest analogy. Your route table, dependency injection, and startup wiring
all become declarations; your business logic stays code — it just lives behind a
resource boundary instead of inside a controller class.

| You had | You now write |
| --- | --- |
| `app.listen(port)` | an `Http.Server` resource, started via `targets:` |
| A router / controller class | an `Http.Api` with `routes:`, mounted on the server |
| Middleware | a `Telo.Mount` resource, or declared behaviour on the route |
| Request validation (zod, pydantic, DTOs) | the route's `request.schema` — rejection happens before your handler |
| A DI container wiring services at boot | `!ref` between resources; ordering is derived, not declared |
| `process.env` reads scattered around | one `variables:` / `secrets:` block on the application |
| A `/healthz` route you wrote by hand | still a route you write — see [Running in production](/deploy/production) |

**Where does my business logic go?** In a resource — and more of it is
declarable than the YAML suggests. Orchestration is a `Run.Sequence`. A decision
is a `Run.Choice`. Shaping a value is a `Run.Value`, whose `bindings:` let you
name the steps of a calculation without a resource each, and whose expressions
reach a CEL library that already covers hashing, UUIDs, timestamps, regex
captures, JSON parsing and base64. Mapping over a collection is a
`Run.Projection`; grouping and aggregating is the `collection` module. An
intermediate derived from a step's result is a step carrying `value:` instead of
`invoke:` — no dispatch, no span, no topology node. What is left for a
controller is what genuinely needs code: a Node API, a native library, an
algorithm.

**Can I just write JavaScript?** Yes — but by the time you need it you are
usually reaching for a platform API (`fetch`, `Buffer`, streams, crypto), not
for logic, and most of those have a kind of their own. Treat a script as the
escape hatch it is: a step graph stays visible to the analyzer, the editor and
the topology view; the inside of a script is opaque to all three.

## From Kubernetes / Helm

The YAML rhymes, the model does not. Kubernetes YAML describes *workloads for a
cluster to schedule*. A Telo manifest describes *the inside of one process*.

| Kubernetes | Telo |
| --- | --- |
| A Deployment's containers | irrelevant — Telo runs *inside* one container |
| CRD + operator | `Telo.Definition` + controller — the same idea, in-process |
| A resource's `spec:` | the fields directly on the document; there is no `spec:` |
| `kubectl apply`, reconciled forever | `telo run` — a boot sequence, not a control loop |
| ConfigMap / Secret | `variables:` / `secrets:` bound to env vars |
| Helm templating a string | `!cel` expressions, type-checked against real schemas |
| Probes you configure | a route you declare |

The one that catches people: **Telo does not reconcile.** The init loop runs
once at boot, resolves dependency order, and then the application runs. It is
not continuously driving the world toward a declared state. Your orchestrator
still owns restarts, scaling, and rollout — Telo is what runs in the pod.

## From Terraform / Pulumi

Both are declarative and both build a dependency graph, so the instinct
transfers well. The difference is *what* is declared: Terraform declares
infrastructure that outlives the run, Telo declares the runtime components of an
application that exist only while the process lives.

There is no state file, no plan/apply split, and no drift detection — the
dependency graph is rebuilt from the manifest on every boot. What Terraform gets
from `terraform plan`, Telo gets from `telo check`: an analysis pass that
resolves references and type-checks expressions without running anything.

## Questions this raises

**Is this a workflow engine?** No, though it can host one. `Run.Sequence` is
in-process control flow — it does not persist state across a crash. When you
need durable workflows (retries surviving a restart, long-running sagas), the
`workflow` module declares that explicitly, with a backend such as Temporal
behind it.

**Do I have to write YAML for everything?** The declarative surface is wiring:
what exists, what it is connected to, what runs. Logic stays code. If you find
yourself expressing an algorithm in `!cel`, that is the signal to write a script
or a controller.

**Why not just write the code?** Because a manifest is data. It can be
type-checked before it runs, rendered as a topology, edited in a GUI, searched
for every use of a kind, and analyzed for what it exposes — none of which is
possible once the wiring is buried in imperative startup code. That property is
protected deliberately: anything that would make a manifest un-analyzable is out
of scope for Telo.

**What is the runtime, really?** One Node.js process (a Rust kernel is in
progress). Scale it with replicas like any other service.

**How do I debug it?** `telo check` before running, `--verbose` for logs,
`--debug` for a full event log, `--inspect` for a live view of a running app.
Codes are in the [diagnostics reference](/reference/diagnostics).

## Next

- [How Telo works](/learn/how-telo-works) — the model these all map onto.
- [Your first HTTP API](/learn/first-http-api) — build the thing this page keeps
  describing.
