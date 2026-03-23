# Telo AI Module Specification (v0.1 Draft)

## Overview

The `Ai` module provides LLM integration for Telo manifests. It exposes four resource kinds:

| Kind            | Capability | Purpose                                                                           |
| --------------- | ---------- | --------------------------------------------------------------------------------- |
| `Ai.Model`      | Provider   | Declares an LLM connection (API key, provider, model name)                        |
| `Ai.Completion` | Invocable  | Single-turn LLM call — prompt in, response out                                    |
| `Ai.Agent`      | Invocable  | Multi-turn loop — receives a goal, calls tools until done, returns final response |
| `Ai.Worker`     | Invocable  | Ephemeral agent assembled at runtime by a parent agent from a declared tool pool  |

---

## 1. `Ai.Model` — Provider

Declares a connection to an LLM provider. Other resources reference it by name.

```yaml
kind: Kernel.Import
metadata:
  name: Ai
source: ../modules/ai
---
kind: Ai.Model
metadata:
  name: Gpt4o
  module: MyApp
provider: openai
model: gpt-4o
apiKey: "${{ secrets.OPENAI_API_KEY }}"
```

### Fields

| Field      | Type   | Required | Description                                            |
| ---------- | ------ | -------- | ------------------------------------------------------ |
| `provider` | string | yes      | LLM provider (`openai`, `anthropic`, `ollama`, …)      |
| `model`    | string | yes      | Model identifier as accepted by the provider           |
| `apiKey`   | string | no       | API key; use a CEL secret reference                    |
| `baseUrl`  | string | no       | Override the provider's default API base URL           |
| `options`  | object | no       | Provider-specific options (temperature, max_tokens, …) |

---

## 2. `Ai.Completion` — Invocable

A single-turn LLM call. Accepts a prompt or a messages array, returns the model's response text.

### Inline usage (inside `Pipeline.Job`)

```yaml
kind: Pipeline.Job
metadata:
  name: SummarizeText
  module: MyApp
steps:
  - name: Summarize
    inputs:
      text: "${{ vars.articleText }}"
    invoke:
      kind: Ai.Completion
      model: Gpt4o
      system: "You are a concise summarizer. Return only the summary."
      messages:
        - type: user
          content: "Summarize the following:\n${{ inputs.text }}"

  - name: SaveSummary
    inputs:
      summary: "${{ Summarize.outputs.text }}"
    invoke:
      kind: Sql.Exec
      connection: Db
      inputs:
        sql: "INSERT INTO summaries (text) VALUES (?)"
        bindings:
          - "${{ inputs.summary }}"
```

### Named resource usage

Declare as a named resource to reuse across multiple pipeline steps or API handlers.

```yaml
kind: Ai.Completion
metadata:
  name: Summarizer
  module: MyApp
model: Gpt4o
system: "You are a concise summarizer. Return only the summary."
```

Then invoke by name:

```yaml
steps:
  - name: Run
    inputs:
      prompt: "Summarize: ${{ vars.text }}"
    invoke:
      kind: Ai.Completion
      name: Summarizer
```

### Fields

| Field      | Type   | Required | Description                              |
| ---------- | ------ | -------- | ---------------------------------------- |
| `model`    | string | yes      | Reference to an `Ai.Model` resource name |
| `system`   | string | no       | System prompt                            |
| `messages` | array  | no       | Full messages array                      |

Exactly one of `prompt` or `messages` must be provided at invocation time via `inputs`.

### Outputs

| Field   | Type   | Description                                                     |
| ------- | ------ | --------------------------------------------------------------- |
| `text`  | string | The model's response content                                    |
| `usage` | object | Token counts: `{ promptTokens, completionTokens, totalTokens }` |

---

## 3. `Ai.Agent` — Invocable

A multi-turn agent loop. The kernel sends the goal to the model, executes any tool calls the model requests, feeds results back, and repeats until the model produces a final response.

Tools are defined inline with `invoke:` — any `Invocable` resource kind can be wired as a tool.

```yaml
kind: Ai.Agent
metadata:
  name: ResearchAgent
  module: MyApp
model: Gpt4o
system: "You are a research assistant. Use the available tools to answer questions."
tools:
  - name: fetch_page
    description: Fetch the contents of a URL
    inputSchema:
      type: object
      properties:
        url:
          type: string
      required: [url]
    invoke:
      kind: Http.Request
      method: GET
      url: "${{ inputs.url }}"

  - name: search_notes
    description: Search saved notes by keyword
    inputSchema:
      type: object
      properties:
        keyword:
          type: string
      required: [keyword]
    invoke:
      kind: Sql.Query
      connection: Db
      inputs:
        sql: "SELECT id, text FROM notes WHERE text LIKE ?"
        bindings:
          - "%${{ inputs.keyword }}%"
```

Invoking the agent from a pipeline step:

```yaml
steps:
  - name: AskAgent
    inputs:
      goal: "What is the capital of France? Check the notes first."
    invoke:
      kind: Ai.Agent
      name: ResearchAgent

  - name: PrintAnswer
    inputs:
      answer: "${{ AskAgent.outputs.text }}"
    invoke:
      kind: Console.Log
      message: "${{ inputs.answer }}"
```

### Sub-agents as tools

An `Ai.Agent` is itself `Invocable`, so it can be wired as a tool of another agent without any wrapper:

```yaml
kind: Ai.Agent
metadata:
  name: OrchestratorAgent
  module: MyApp
model: Gpt4o
system: "You are an orchestrator. Delegate research tasks to the research agent."
tools:
  - name: research
    description: Delegate a research question to the research sub-agent
    inputSchema:
      type: object
      properties:
        question:
          type: string
      required: [question]
    invoke:
      kind: Ai.Agent
      name: ResearchAgent
      inputs:
        goal: "${{ inputs.question }}"
```

### Fields

| Field           | Type    | Required | Description                                                                    |
| --------------- | ------- | -------- | ------------------------------------------------------------------------------ |
| `model`         | string  | yes      | Reference to an `Ai.Model` resource name                                       |
| `system`        | string  | no       | System prompt                                                                  |
| `tools`         | array   | no       | Tool definitions (see below)                                                   |
| `maxIterations` | integer | no       | Hard limit on tool-call rounds before the loop is forced to stop (default: 10) |

### Tool definition fields

| Field         | Type   | Required | Description                                                                       |
| ------------- | ------ | -------- | --------------------------------------------------------------------------------- |
| `name`        | string | yes      | Tool name exposed to the model                                                    |
| `description` | string | yes      | Natural-language description the model uses to decide when to call the tool       |
| `inputSchema` | object | yes      | JSON Schema describing the tool's input object                                    |
| `invoke`      | object | yes      | Inline `Invocable` invocation; `inputs.*` fields may use CEL referencing `inputs` |

### Outputs

| Field        | Type    | Description                                               |
| ------------ | ------- | --------------------------------------------------------- |
| `text`       | string  | The model's final response after all tool rounds complete |
| `usage`      | object  | Aggregated token counts across all iterations             |
| `iterations` | integer | Number of tool-call rounds executed                       |

---

## 4. `Ai.Worker` — Invocable

A dynamically-assembled, ephemeral agent created at runtime by an `Ai.Agent`. While `Ai.Agent` resources are declared in the manifest with a fixed set of tools, a worker is assembled on demand — the spawning agent selects which tools it receives and what goal it pursues, based on work discovered during execution.

Workers are disposable: they run once, return a result, and are discarded.

### Declaring a worker-capable agent

The parent agent declares a `toolPool` — the set of tools available for workers to draw from — and gains a built-in `spawn_worker` tool.

```yaml
kind: Ai.Agent
metadata:
  name: OrchestratorAgent
  module: MyApp
model: Gpt4o
system: "You are an orchestrator. Break goals into subtasks and spawn workers to handle each one."
toolPool:
  - name: fetch_page
    description: Fetch the contents of a URL
    inputSchema:
      type: object
      properties:
        url: { type: string }
      required: [url]
    invoke:
      kind: Http.Request
      method: GET
      url: "${{ inputs.url }}"

  - name: run_sql
    description: Run a read-only SQL query
    inputSchema:
      type: object
      properties:
        sql: { type: string }
      required: [sql]
    invoke:
      kind: Sql.Query
      connection: Db
      inputs:
        sql: "${{ inputs.sql }}"
```

When `toolPool` is present, the kernel automatically adds a `spawn_worker` tool to the agent. The agent calls it to create and run a worker:

```json
{
  "tool": "spawn_worker",
  "inputs": {
    "system": "You are a web researcher. Fetch and summarize the given URL.",
    "tools": ["fetch_page"],
    "goal": "Summarize https://example.com/article"
  }
}
```

The worker runs its own agent loop using only the listed tools, then returns its final response as the tool result.

### Fields on `spawn_worker` input

| Field    | Type             | Required | Description                                             |
| -------- | ---------------- | -------- | ------------------------------------------------------- |
| `system` | string           | no       | System prompt for the worker                            |
| `tools`  | array of strings | yes      | Names from the parent's `toolPool` to grant this worker |
| `goal`   | string           | yes      | The goal passed as the worker's initial user message    |

### Constraints

- `tools` must be a subset of the parent's `toolPool` — referencing an unlisted name is a runtime error
- Workers cannot spawn other workers — `spawn_worker` is not available inside a worker's tool loop
- Workers do not share conversation history with the parent agent
- `maxIterations` from the parent applies to each worker independently

### Optional fields on the parent agent

| Field                 | Type    | Default                  | Description                                                         |
| --------------------- | ------- | ------------------------ | ------------------------------------------------------------------- |
| `toolPool`            | array   | —                        | Tools available for workers to use; presence enables `spawn_worker` |
| `maxWorkers`          | integer | 4                        | Maximum number of workers that may run concurrently                 |
| `workerMaxIterations` | integer | inherits `maxIterations` | Per-worker iteration limit                                          |

### When to use `Ai.Worker` vs `Ai.Agent` as a sub-agent tool

|                  | `Ai.Agent` as tool           | `Ai.Worker`                          |
| ---------------- | ---------------------------- | ------------------------------------ |
| Tool composition | Fixed at manifest-write time | Chosen by the agent at runtime       |
| Identity         | Named, reusable resource     | Ephemeral, no name                   |
| System prompt    | Fixed at manifest-write time | Set by the spawning agent at runtime |
| Best for         | Known, reusable sub-agents   | Discovered or variable workloads     |

---

## 5. Behavioral Contracts

### 5.1. Tool execution

- The kernel executes tool calls **sequentially** in the order the model requests them within a single iteration.
- Tool outputs are returned to the model as tool result messages before the next iteration begins.
- If a tool invocation throws, the error message is returned to the model as the tool result. The loop continues — it is the model's responsibility to handle errors.

### 5.2. Loop termination

The agent loop terminates when:

1. The model produces a response with no tool calls.
2. `maxIterations` is reached — the kernel returns whatever final text the model produced in the last iteration.

### 5.3. `Ai.Completion` inside `Ai.Agent`

An `Ai.Completion` invocation used as a tool performs a single stateless LLM call. It does not share conversation history with the parent agent.

### 5.4. Secrets and CEL

`apiKey` on `Ai.Model` must reference a secret via CEL:

```yaml
apiKey: "${{ secrets.OPENAI_API_KEY }}"
```

Hardcoded keys in manifests will cause a schema validation error.
