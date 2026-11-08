# Authoring benchmark

Whether a coding agent builds the same app, and changes to it, with fewer tokens in Telo than in plain Node. One general agent — Claude Code, run non-interactively — gets the prose of the lead-intake [`CONTRACT.md`](../lead-intake/CONTRACT.md) and nothing else of the benchmark; the contract tests are Telo manifests the Node side could not run, so neither side sees them. They judge each attempt from outside.

| Task | The agent is given | Judged by |
| --- | --- | --- |
| `build` | `CONTRACT.md` | the base contract tests, [`../lead-intake/contract/run.yaml`](../lead-intake/contract/run.yaml) |
| `add-field` | `CONTRACT.md`, `TASK.md` and the repo's implementation of its side | the base cases plus [`tasks/add-field/contract.yaml`](./tasks/add-field/contract.yaml) |
| `add-validation-rule` | the same | the base cases plus [`tasks/add-validation-rule/contract.yaml`](./tasks/add-validation-rule/contract.yaml) |
| `add-endpoint` | the same | the base cases plus [`tasks/add-endpoint/contract.yaml`](./tasks/add-endpoint/contract.yaml) |

A change task's directory holds its `TASK.md` and its `contract.yaml`, an application that imports the base contract library and lists its own cases beside `Contract.cases` (see [`../lead-intake/README.md`](../lead-intake/README.md)). The Telo starter imports the standard library as published artifacts at the versions of this checkout.

## One attempt

`run.mjs` does one attempt at a time:

1. It prepares a workspace holding the prose (and the starter), and starts a fresh container on it — `docker/telo.Dockerfile` (Node, the published `@telorun/cli`, Claude Code, [the authoring primer](../../apps/authoring-agent/chat/primer.md) as the agent's user memory, an MCP config for the hub) or `docker/node.Dockerfile` (Node, npm, Claude Code).
2. It runs `claude -p … --output-format stream-json --verbose --model <pinned> --max-budget-usd 20` in it, with a 60 minute limit.
3. It reads the token counts, cost and turns from the final `result` event, and counts tool calls from the `tool_use` blocks of the `assistant` events.
4. Outside the container it boots the built app on a fresh `STATE_DIR` (Node: `npm install` if the agent left no `node_modules`, `npm run build --if-present`, `npm start`; Telo: `telo run telo.yaml`) and runs the task's contract tests with `telo run`. Passing them is parity.

An attempt past 60 minutes or USD 20 counts as failed, and its app is not tested. A timed-out attempt's tokens are summed from the events seen, and its `costUsd` is `null`. An agent that produced no result, or failed before using the model (a missing API key, an unreachable image), stops the run: that is a fault of the setup, not a failed attempt.

One line per attempt, appended to `<out>/records/<task>-<side>.jsonl`:

```json
{"commit":"8b808da48","teloVersion":"0.112.0","model":"claude-opus-5-5","task":"build","side":"telo","attempt":3,"tokens":{"input":182340,"output":41210,"cacheRead":2410388,"cacheWrite":201544},"costUsd":4.12,"turns":38,"toolCalls":121,"wallSeconds":1460,"contractTestsPassed":true,"linesWritten":412}
```

`linesWritten` is the non-blank lines in the final workspace that the starting workspace did not hold, excluding `node_modules`, `dist`, `.telo`, lockfiles, database and trace files.

## Running it

```console
$ ANTHROPIC_API_KEY=… node benchmarks/authoring/run.mjs run --out out --build-images --telo-version 0.112.0 --tasks build --sides telo --attempts 1
$ node benchmarks/authoring/run.mjs summary --out out
$ node benchmarks/authoring/run.mjs compare --out out --run
```

An attempt spends real tokens — up to USD 20 — and takes up to an hour; the full run is 40 attempts. `node run.mjs --help` lists every option; `TELO_COMMAND` names the telo command that runs the contract tests and the Telo app (default `telo`, which must be the release under test). The key is only forwarded into the container by name (`--forward-env`, default `ANTHROPIC_API_KEY`).

- `summary` reads every `<out>/records/*.jsonl`, writes `<out>/authoring.jsonl` (the file [`../history/append.mjs`](../history/README.md) appends) and `<out>/summary.md`, and prints per task and side the success rate and, over the passing attempts, the median total tokens (input, output, cache reads and cache writes — on the Telo side that includes the primer and hub context), cost and time. It refuses records of several models.
- `compare` takes the first passing `build` attempt of each side, builds it, and writes `<out>/comparison/comparison.yaml`, a `Benchmark.Comparison` in the shape of [`../lead-intake/comparison.yaml`](../lead-intake/comparison.yaml) with the built apps as subjects (`agentTelo`, `agentNode`); the Node subject runs the app's `scripts.start` directly when it is a plain `node` command, else `npm start --silent` (npm's process then counts toward the app, and the manifest says so in a comment), and the Telo subject sets `TELO_CACHE_DIR: .telo` so its cold boots are cold; `--run` runs it (Linux, `taskset`, 2+ physical cores) and writes `comparison.json` beside it.

## In CI

[`.github/workflows/benchmarks-authoring.yml`](../../.github/workflows/benchmarks-authoring.yml) runs it on `workflow_dispatch` only, against a published CLI (the latest by default) and the hub: one job per task and side, then one job that appends all records to `authoring.jsonl` on `benchmark-results`, then the comparison of the built apps. It reads the repository secret `ANTHROPIC_API_KEY`.

## Tests

`node --test benchmarks/authoring/tests/harness.test.mjs` (CI runs it through `tests/harness.yaml`) uses a fake agent in place of the container and the model. It runs the real contract tests against known apps — the repo's implementations, and a solution of each change task kept in `tests/__fixtures__/solutions/` — so it also proves that every change task's added cases fail an unmodified implementation and pass a correct one.
