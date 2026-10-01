# Plan approval runner protocol

The wire shapes a [plan-approval server](../plan-approval/README.md) and its
[runners](../plan-approval-runner/README.md) exchange, as four exported
`Telo.JsonSchema` instances. Types only: no kinds, no controllers.
Unpublished: the server and the runner import it by relative path from a
checkout of this repository.

```yaml
imports:
  RunnerProtocol: ../plan-approval-runner-protocol
```

| Shape | Carried by | Holds |
| --- | --- | --- |
| `RunnerReport` | `PUT /api/agent/runners/{name}` — request body | `{instance, repos, sessions}`: the process's instance UUID, the slugs of the repositories it serves (never a path), and the running background sessions it sees in them, `[{id, repo}]` |
| `RunnerCommand` | an entry of `CommandPage.commands` | one of the three shapes below |
| `CommandPage` | `GET /api/agent/runners/{name}/commands` — response body | `{commands: [RunnerCommand], cursor}` — `cursor` is the next long poll's `after` |
| `CommandOutcome` | `POST /api/agent/runners/{name}/commands/{seq}/outcome` — request body | `{instance, state: done, session?}` or `{instance, state: failed, error: {code, message}}` |

A `RunnerCommand` is exactly one of:

| `type` | Fields |
| --- | --- |
| `wake` | `seq`, `repo`, `session`, `plan`, `planSeq`, `decision` (`approve` \| `request_changes` \| `reject`) |
| `start` | `seq`, `repo`, `sessionName` (`plan-approval-<uuid>`, minted by the server), `prompt`, `author` — no `session`: claude assigns the ID |
| `stop` | `seq`, `repo`, `session`, `author` |

**Outcomes.** A `done` start carries `session`: the ID claude gave the session
started under `sessionName`, which the server then records as the runner's
(`ERR_SESSION_OWNED` if another runner already owns it). No other outcome
carries a session; the server refuses a `done` start without one, or a session
on a wake or stop, with 422 `ERR_OUTCOME_INVALID`. A `failed` outcome always
carries `error`. The codes a runner reports:

| Code | Meaning |
| --- | --- |
| `ERR_CLAUDE_FAILED` | a Claude CLI call exited non-zero, a start left no session of its name, or a wake started a copy or left the session not running |
| `ERR_SESSION_NOT_FOUND` | claude lists no such session (a wake), or no background entry of it (a stop) |
| `ERR_REPO_NOT_SERVED` | the command's repository is not one this runner serves, or a woken session runs outside it |

## Who checks what

- **The server's** operations library, [PlanApprovalPlans](../plan-approval/plans/README.md), types the operations behind those routes
  with these shapes: the report and the outcome as their inputs, the page as the
  feed's output. The routes' own request schemas are inline copies of the
  shapes, and each route maps its body into the operation field by field, so
  the operation's contract checks what the route passes on when a request
  arrives. The feed route
  declares no response schema: its body is the operation's result, checked
  against `CommandPage`.
- **The runner** wraps each server call in a sequence typed with the shape it
  sends or receives. A misspelled field of the feed page fails `telo check`, and
  a page the server answers in any other shape fails the call with
  `ERR_OUTPUT_INVALID`.

The operations library and the runner import this library, under the alias
`RunnerProtocol`; the server application does not, and neither application
imports the other.
