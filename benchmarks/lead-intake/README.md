# Lead-intake benchmark

One API, specified in [`CONTRACT.md`](./CONTRACT.md), implemented twice and compared:

| Path | What |
| --- | --- |
| `telo/` | The Telo implementation (`telo run telo.yaml`). Reads `PORT` and `STATE_DIR`; `TRACE=true` attaches a file sink and the trace sink, so the startup span lands in `spans.jsonl`. |
| `node/` | The native implementation: `src/` is compiled by `pnpm --filter @telorun/bench-lead-intake build` into the git-ignored `dist/`, which `node dist/server.js` runs. |
| `contract/` | The contract tests, as a Telo library of cases plus a runnable application. |
| `tests/` | The CI tests: the contract run against each implementation. |
| `comparison.yaml` | The `Benchmark.Comparison` of the two (see [`../README.md`](../README.md)). |

## Running the contract tests against any URL

`contract/run.yaml` is an application whose only input is the `BASE_URL` of the implementation (default `http://127.0.0.1:8845`):

```console
$ BASE_URL=http://127.0.0.1:8080 telo run benchmarks/lead-intake/contract/run.yaml
```

It makes the requests of `CONTRACT.md` and asserts the status and body of every answer, including the `derived` fields of all three levels. It writes leads to the implementation, so start it on a state directory of its own. Parity is passing this run.

The CI tests start an implementation first: `tests/telo-implementation.yaml` as an `App.Instance` child on port 8871, `tests/node-implementation.yaml` through `node/run-contract.mjs`, which builds the Node implementation, starts it on a fresh temporary `STATE_DIR` on port 8872, runs `contract/run.yaml` with `telo` and stops it. `TELO_COMMAND` names the command that runs telo (default: the checkout's own CLI under bun).

## Adding cases (a change task)

The base cases are the library `contract/telo.yaml`: it takes the variable `baseUrl` and exports one `Telo.Sequence`, `cases`. A test for a changed contract imports it and lists its own cases beside it:

```yaml
kind: Telo.Application
metadata: { name: LeadIntakeWithTier }
imports:
  Contract:
    source: ../../benchmarks/lead-intake/contract
    variables: { baseUrl: !cel "variables.baseUrl" }
  HttpClient: ../../modules/http-client
  Assert: ../../modules/assert
variables:
  baseUrl: { env: BASE_URL, type: string }
targets:
  - !ref Contract.cases
  - !ref addedCases
---
kind: Telo.Sequence
metadata: { name: addedCases }
steps: [] # the requests and Assert.Equals steps of the change
```

A change that alters a base case (say, a field every lead answer now carries) is tested by the changed contract's own copy of that case, not by the base run.
