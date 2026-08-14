---
description: "How Telo compares to n8n, Dify, Windmill, Node-RED, Zapier, Retool and OutSystems — what each one builds, who owns the artifact, and when another platform is the better choice."
---

# Compared to low-code platforms

Telo is low-code, and this page is a comparison from inside the category, not a
rejection of it. A manifest is a declarative artifact, the editor is a canvas
with schema-driven forms, and most of what an application does is composed
rather than written. That is the same bargain every platform below offers.

Where they part company is **who the tool is for and who owns what it makes**.
Most low-code platforms build an application for someone who is not a
programmer, and keep the artifact in their own store. Telo builds a backend
service for a team that is, and the artifact is a file in your repository. Those
two choices explain almost every row that follows.

This page compares seven platforms across the axes that actually differ. It
deliberately avoids connector counts and pricing, both of which change monthly.

## The platforms

| | What you build | Where it runs | Source of truth | Extending it | License |
| --- | --- | --- | --- | --- | --- |
| **Telo** | A backend service — HTTP APIs, jobs, agents | Your own container, one process | YAML in your repo | A `Telo.Definition` + controller, in Node.js, Rust or Go | Fair-code (Sustainable Use) |
| **n8n** | An automation between SaaS apps | n8n Cloud, or a self-hosted server | The n8n database; JSON export | A custom node in n8n's SDK | Fair-code (Sustainable Use) |
| **Windmill** | Scripts and flows, developer-first | Windmill Cloud, or a self-hosted server + workers | Scripts in git, synced to the workspace | Ordinary code in TS/Python/Go | AGPL-3.0 (+ enterprise edition) |
| **Node-RED** | A message flow, often at the edge | A Node-RED server you host | `flows.json` | A custom node package on npm | Apache-2.0 |
| **Zapier / Make** | An automation between SaaS apps | The vendor's cloud only | The vendor's account | A published app in the vendor's platform | Proprietary SaaS |
| **Dify** | An LLM app — chatbot, agent or RAG pipeline — with a hosted chat UI and an API | Dify Cloud, or self-hosted with Docker | Dify's database; a YAML DSL export | A plugin or tool in Python, or any OpenAPI endpoint | Apache-2.0 with added conditions |
| **Retool** | An internal web UI, backend included | Retool Cloud, or self-hosted on enterprise plans | Retool's own store; git sync on higher tiers | JavaScript in the app, custom components | Proprietary |
| **OutSystems / Mendix** | A full-stack application, UI included | The vendor's platform | The vendor's model repository | Extensions in the vendor's IDE | Proprietary |

Others in the same space: **Appsmith** (Apache-2.0) and **Budibase**
(GPL-3.0) sit beside Retool as internal-tool builders; **Flowise** and
**LangFlow** sit beside Dify as visual LLM-app builders; **Power Automate** and
**Power Apps** are the Microsoft counterpart to Zapier and Retool.

## What gets built

This is the distinction that decides whether the rest of the page is relevant
to you.

- **Telo** produces a backend process. Something else calls it: a browser, a
  mobile app, another service, an agent. There is no page-and-button builder —
  if you want an admin screen, the frontend is yours to write.
- **Retool, Budibase, Appsmith, OutSystems, Mendix** produce a screen. The
  point of the tool is that a non-developer opens a browser and clicks a button
  you placed.
- **n8n, Zapier, Make, Node-RED** produce neither — they produce a running
  automation with no interface at all.
- **Dify** produces both: a hosted chat interface for end users and an API for
  your own. It is the closest overlap on this page — Telo's `ai`, `embedding`,
  `vector-store` and `mcp-server` modules build the same class of thing. The
  split is what surrounds the model: Dify gives you a chat UI, a prompt-tuning
  surface and a RAG pipeline out of the box, and an LLM app is what it builds;
  in Telo an AI model is one resource kind among many, wired to HTTP, SQL,
  queues and schedulers by the same rules as everything else.

Telo has a visual builder, but it builds a *service*, not a *screen*. That is a
scope statement, not a ranking: if what you need is an admin table over a
database by Thursday, an internal-tool builder will get you there faster and
this page is not an argument against it.

## Who the visual editor is for

Every tool here has a canvas. What differs is which direction it is
authoritative in.

| | Canvas edits | Text is |
| --- | --- | --- |
| **Telo** | the YAML file the CLI runs | the source of truth, both directions |
| **n8n**, **Node-RED**, **Retool**, **Dify** | the platform's own store | an export — a byproduct |
| **Windmill** | scripts synced from git | the source of truth; the GUI is secondary |
| **OutSystems / Mendix** | a proprietary model | not available |

Telo is the only one where the canvas and the file are the same artifact in
both directions. You can draw a topology in the [editor](/build/editor), commit
the YAML, have a colleague review the diff in a pull request, edit it by hand in
Vim, and reopen it on the canvas unchanged. That round-trip is a hard design
constraint — see [How Telo works](/learn/how-telo-works) — not a feature that
happens to work today.

The consequence for your team: the same manifest is legible to a developer in a
diff and to a reviewer on a canvas. GUI-authoritative platforms make you choose,
and the choice is usually made for you by whoever built the flow first.

## Correctness before it runs

The sharpest difference, and the one that is hardest to see in a demo.

| | Telo | The others here |
| --- | --- | --- |
| Wiring errors | `telo check` resolves every reference and rejects a wrong one statically | The node runs and fails, usually in production |
| Expressions | CEL, type-checked against real JSON Schemas — a typo in a field name is an error | Untyped `{{ }}` templates, evaluated at run time |
| Connections | A `!ref` slot declares the kind it accepts; an incompatible wire will not load | Any node output connects to any node input |
| Contracts | Inputs and outputs are declared schemas, validated at dispatch | Whatever shape the previous node happened to emit |
| Error paths | A `catches:` entry is checked against the errors that step can actually raise, and `error.code` is type-checked inside the branch | An error branch you wire up; what arrives in it is discovered at run time |
| Testing | Manifest tests live beside the code and run in CI | Re-run the flow and look at it |

A flow-based tool tells you what happened after it happened. Telo's analyzer
answers the same questions without executing anything: does this reference
resolve, does this expression type-check against the schema of the thing it
reads, can this resource ever be reached. That is what makes a manifest safe to
refactor, and it is why the analyzer is a first-class package rather than a lint
script. See [Catching errors early](/learn/static-analysis).

## Extending and sharing

On most of these platforms the ceiling is the connector catalogue. Telo makes
the opposite trade: a small standard library of composable primitives, plus a
first-class path to your own.

- **A new capability is a module** — a `Telo.Definition` describing the kind and
  a controller implementing it. It is not a plugin in a vendor SDK; it is the
  same mechanism every built-in kind uses.
- **Controllers are polyglot** — Node.js, Rust and Go. The kind's contract is
  language-neutral by design, so which language a controller is written in is
  invisible to the manifest that uses it. Node.js ships today; the Rust kernel
  is in progress.
- **Modules publish as OCI artifacts** with semver, imports pinned by digest,
  and discovery through the [hub](https://hub.telo.run). Reuse is a versioned
  dependency, not a copied template.
- **Composition is the point.** `Run.Sequence`, `Run.Choice`, `Run.Projection`
  and `!cel` compose the primitives you have, so the catalogue does not need an
  entry for every combination.

The honest cost: Zapier reaches thousands of SaaS apps and n8n reaches hundreds.
Telo's standard library covers HTTP, SQL, caching, queues, AI models, MCP,
scheduling and the rest of the infrastructure surface — but if your problem is
"post this to Notion when a HubSpot deal closes", the connector already exists
over there and does not here.

## Operating it

| | Telo | The others here |
| --- | --- | --- |
| Deploy | `telo run ./manifest.yaml` on your laptop, or a container image you run anywhere — Docker, Lambda, your cluster | The vendor's cloud, or a stateful self-hosted install |
| Scale | Stateless replicas, like any other service | A queue plus a worker pool the platform manages |
| Performance | A step is an in-process call — no queue hop, no per-step persistence; expressions and schemas compile once at load | Per-step orchestration overhead, plus a network round trip per connector call on the hosted platforms |
| Load testing | `Benchmark.Suite` — a resource in the same manifest, with p99 thresholds that fail CI | An external tool, if the platform can be driven by one |
| Observability | Structured logging, OTLP tracing, `--inspect` for a live topology | A per-execution log viewer |
| Durable state | Not today — durable execution is in progress | Built in on the workflow platforms |

The performance difference is architectural rather than a matter of tuning. An
automation platform schedules an execution, then moves it between nodes through
a queue, usually persisting the payload at each hop — that is what buys the
durability in the row below, and it costs milliseconds per step before any of
your work happens. A Telo application is one process: a step is a function call,
CEL is compiled at load rather than interpreted per invocation, and schemas
compile to validators once and are cached. Serving an HTTP request never leaves
the process.

Be honest about where that shows up. It matters on the request path — an API
under real traffic, a high-volume ingest, anything measured in requests per
second per replica. It disappears when a single slow dependency dominates: a
model call, a third-party API, an unindexed query. Telo does not make your
database faster, and on an LLM workflow the orchestration overhead is noise
either way. Where it does matter, `Benchmark.Suite` measures it from inside the
same manifest, with `p99` thresholds that exit non-zero in CI.

Telo runs inside one process and boots once; it does not persist state across a
crash. The automation platforms do, and for a long-running saga that matters
today. See [Coming from somewhere else](/learn/coming-from) for where that line
sits.

## Where Telo is weaker

- **No end-user UI builder.** You build the service; the screens are yours.
- **No hosted offering yet.** Telo Cloud — hosted runs and managed deploys — is
  planned. Today you deploy the container yourself.
- **A small connector catalogue** next to any established automation platform.
- **Not aimed at non-programmers.** The editor lowers the cost of authoring for
  a developer; it does not make a manifest something an operations analyst will
  own.
- **Pre-1.0.** Breaking changes ship as minor releases, deliberately, while the
  surface settles.

## When another platform is the right choice

- A one-off internal screen over a database, needed this week.
- An automation that a non-developer must own and change without you.
- A workflow whose value is entirely in the connectors — a chain of SaaS calls
  with no logic worth type-checking.
- A RAG chatbot that needs a hosted chat UI on day one, and a prompt surface a
  non-engineer will iterate on without touching a repository.
- A team with no appetite for running a container.

Telo earns its place when the thing you are building is a service that will be
maintained: reviewed in pull requests, tested in CI, refactored a year from now,
and extended with capabilities nobody sells as a connector.

## Next

- [How Telo works](/learn/how-telo-works) — the model underneath all of this.
- [Coming from somewhere else](/learn/coming-from) — the same exercise for web
  frameworks, Kubernetes and Terraform.
- [Your first HTTP API](/learn/first-http-api) — build one and judge for
  yourself.
