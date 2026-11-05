---
status: done
priority: medium
depends-on: []
packages: [sdk, kernel, cli, kernel/rust, sdk/rust, modules/http-server, modules/mcp-server, modules/otlp, docs]
tracking: feat/telo-stack-traces
---

# Telo stack traces instead of host stacks

A failure written to a log names the resources and manifest lines it passed through, not the JavaScript that ran them. A host stack is written only where it is the finding: a failure no code describes, which is a bug in controller or kernel code.

## Today

A log record's error (`ErrorValue`, `kernel/specs/logging.md` §4.2) carries `stack`, the raw host stack "multi-line, unmodified". `pretty` prints it under the message, `json` writes it, OTLP sends it as `exception.stacktrace`. It names kernel `dist/` files and bundles under `.telo/controller-src/`, exposes host paths, and is a different text on the Rust kernel. Three sites copy `Error.stack` around the error value entirely: the `Http.Api.streamFailed` event payload, the MCP endpoint's error event, and the CLI's `telo: failed to start` line.

The one manifest-shaped fact a failure carries is its `location`: the first caller it leaves, with a pointer into that caller's declaration.

A coded failure inside a route's sequence, on the console today:

```
12:34:56.789 ERROR Http.Api.api  request failed
  ERR_SQL_CONSTRAINT: duplicate key value violates unique constraint "users_email"
    InvokeError: duplicate key value violates unique constraint "users_email"
        at SqlExec.invoke (/home/me/app/.telo/controller-src/sql-3f2a91/sql.mjs:812:11)
        at EvaluationContext.runInvoke (/home/me/.npm/_npx/9c1e/node_modules/@telorun/kernel/dist/evaluation-context.js:2231:28)
        at async runInvokeStep (/home/me/.npm/_npx/9c1e/node_modules/@telorun/sdk/dist/invoke-step.js:801:19)
        at async StepEngine.run (/home/me/.npm/_npx/9c1e/node_modules/@telorun/sdk/dist/step-engine.js:412:7)
```

## After

The same failure:

```
12:34:56.789 ERROR Http.Api.api  request failed
  ERR_SQL_CONSTRAINT: duplicate key value violates unique constraint "users_email"
    at Sql.Exec.insertUser (users/telo.yaml:58:3)
    at Telo.Sequence.createUser#/steps/1 (users/telo.yaml:40:7)
    at Http.Api.api#/routes/3/handler (telo.yaml:18:9)
```

In the `json` encoding, the record's `error`:

```json
{
  "type": "ERR_SQL_CONSTRAINT",
  "message": "duplicate key value violates unique constraint \"users_email\"",
  "stack": "at Sql.Exec.insertUser (users/telo.yaml:58:3)\nat Telo.Sequence.createUser#/steps/1 (users/telo.yaml:40:7)\nat Http.Api.api#/routes/3/handler (telo.yaml:18:9)",
  "frames": [
    { "kind": "Sql.Exec", "name": "insertUser", "module": "file:///home/me/app/users/telo.yaml", "pointer": "", "position": { "line": 58, "column": 3 } },
    { "kind": "Telo.Sequence", "name": "createUser", "module": "file:///home/me/app/users/telo.yaml", "pointer": "/steps/1", "position": { "line": 40, "column": 7 } },
    { "kind": "Http.Api", "name": "api", "module": "file:///home/me/app/telo.yaml", "pointer": "/routes/3/handler", "position": { "line": 18, "column": 9 } }
  ]
}
```

An uncoded failure — a controller bug — keeps its host stack, on the cause only:

```
12:34:56.789 ERROR Http.Api.api  request failed
  ERR_EXECUTION_FAILED: Sql.Exec insertUser failed
    at Sql.Exec.insertUser (users/telo.yaml:58:3)
    at Telo.Sequence.createUser#/steps/1 (users/telo.yaml:40:7)
    at Http.Api.api#/routes/3/handler (telo.yaml:18:9)
  caused by TypeError: Cannot read properties of undefined (reading 'rows')
    host stack
      at SqlExec.invoke (/home/me/app/.telo/controller-src/sql-3f2a91/sql.mjs:814:22)
      at EvaluationContext.runInvoke (/home/me/.npm/_npx/9c1e/node_modules/@telorun/kernel/dist/evaluation-context.js:2231:28)
```

A `throw` inside a `catch:` starts its own trace, and the caught failure's frames stay on its cause:

```
12:34:56.789 ERROR Http.Api.api  request failed
  USER_EXISTS: a user with this email already exists
    at Telo.Sequence.createUser#/steps/1/catch/0 (users/telo.yaml:44:11)
    at Http.Api.api#/routes/3/handler (telo.yaml:18:9)
  caused by ERR_SQL_CONSTRAINT: duplicate key value violates unique constraint "users_email"
    at Sql.Exec.insertUser (users/telo.yaml:58:3)
    at Telo.Sequence.createUser#/steps/1 (users/telo.yaml:40:7)
```

## The model

**A frame** is `{ kind, name, module?, pointer?, position? }` — a resource, the module declaring it, an RFC 6901 pointer into its declaration, and `{ line, column }` (1-based) in the module file. `position` is given only under the rule `location` already follows: for a declaration the load read from a file, whose written document agrees with it along the pointer. A template body's entry, a `base:` parent or a scope member is named with no position.

**Frames are added on the failure path only, at each exit a failure leaves.** Nothing is recorded on a dispatch that succeeds.

- At a dispatch exit the kernel adds, when the failure has no frames yet, the target's frame (pointer empty, positioned at its declaration), then always the caller's frame, its pointer the call site.
- The call site is a new per-dispatch context member, `calledAt`, beside `inputsAt` and handled like it: read at that one dispatch, never inherited by a nested one. The step engine states it for every step (`/steps/1`, nested steps at their full path), the boot runner for every target (`/targets/0`), `Http.Api` for a route's handler (`/routes/3/handler`). A dispatch stating none gives the caller's frame with no pointer.
- A failure in `create()`, `init()` or `run()` carries the failing resource's frame; one in a boot target adds the Application's frame at `/targets/<i>`.
- Frames are bounded at 64; past that the innermost are kept and `dropped_frames_count` says how many were cut.

**Frames follow the failure:**

- `rethrow: {}` keeps them and the exits above keep adding.
- A `throw` step starts a fresh trace with its resource's frame, pointed at the step; inside `catch:` its `cause` keeps the caught failure's frames, rendered under the cause.
- A retry raises the last attempt's frames.
- When the kernel wraps a thrown value (`ERR_EXECUTION_FAILED`, `ERR_FUNCTION_FAILED`), the wrapper carries the frames; the wrapped value becomes its cause.
- Frames are diagnostic only: no catch context (`error.frames` is `CEL_UNKNOWN_FIELD`), no durable record and no trace payload carries them. `location` is unchanged.

**A host stack is written only for an uncoded failure.** An entry of the error value (the error or any cause) whose own thrown value has no non-empty string `code` — a `TypeError`, a bare `Error`, a library's exception — or whose code is `ERR_FATAL` carries `host_stack`. Every coded failure (an `InvokeError`, a coded runtime error, a `throw` step, an ambient code) carries none. There is no switch.

## Changes

1. **Spec — `kernel/specs/invocation-contract.md` §5.5 "Failure trace":** the frame, where frames are added, `calledAt`, the bound, how rethrow / throw / retry / wrapping treat them, that CEL and durable records never see them, and the conformance item. Polyglot debt for `kernel/rust` stated there (task 7).
2. **Spec — `kernel/specs/logging.md`:** §4.2 `ErrorValue` becomes `type`, `message`, `stack` (the Telo trace rendered as text: one `at <kind>.<name>#<pointer> (<file>:<line>:<column>)` line per frame, innermost first, never padded; an empty or absent pointer drops `#<pointer>`, an absent position drops the parenthesised part; the file is relative to the entry module's directory, while `frames` keeps each module's full source), `frames`, `dropped_frames_count`, `host_stack` (uncoded entries only), `cause`; the OTLP mirror is `exception.stacktrace` ← `stack`, `telo.exception.host_stacktrace` ← `host_stack`. §11.2 `pretty` builds the same lines from `frames` under the error line, indented, with each file relative to the working directory so a terminal can open it; `host_stack` after it under a dimmed `host stack` label; the §15 JSON schema gains the three fields.
3. **Spec — `kernel/specs/controller-protocol.md`:** the error payload gains `frames` and `hostStack`, the §6.2 context gains `calledAt`, all additive within `telo-9`. A controller rethrowing a failure carries `frames` unchanged, so frames below an out-of-process controller survive; an SDK sets `hostStack` when a controller's failure was not a structured refusal (a Rust panic, an uncoded throw). `sdk/controller-protocol/` updated to match; `pnpm run check:controller-protocol` passes.
4. **SDK and kernel (Node):** the frame type and `calledAt` on the context; frames gathered at the dispatch, run, init and boot-target exits; the error value built per task 2; the step engine and boot runner state `calledAt`.
5. **Encoders:** `pretty`, `json` and the OTLP encoder write the new fields as task 2 says.
6. **The three bypassing sites:** `Http.Api.streamFailed` and the MCP endpoint's error event carry the error value instead of `{ message, stack, code }`; `Http.Api` states `calledAt` for its handlers; the CLI's start-failure line prints the Telo trace (and `host_stack` for an uncoded failure). A module that reaches a new SDK surface for this declares `requires: telo: ">=<release>"`, verified by execution as the root guide requires.
7. **Rust kernel and SDK:** frames with `kind`, `name` and `module` at its dispatch exit (it carries no pointers or locations yet — pointer and position stay debt in §5.5); a panic's backtrace as `host_stack`; `hostStack` and `frames` read from and written to the protocol error.
8. **Docs:** `docs/guides/logging.md` (what an error record shows), the logging section of `kernel/nodejs/CLAUDE.md`, the http-server and mcp-server event docs. One changeset for the telo line, one `Fixed` fragment per touched module (`telo release add`).

## Verify

- **Manifest test** in `tests/`, logging to a `Telo.FileSink`: an `Http.Api` route's handler is a sequence whose second step invokes a resource that fails with a coded error. The JSONL record's `error` asserted with `Assert.Equals`: `frames` names the failing resource, the sequence at `/steps/1` and the API at `/routes/0/handler`, each with its line and column; no `host_stack`; `stack` contains neither `.js:` nor `.mjs:`.
- Same test with a step whose controller throws an uncoded error: the error is `ERR_EXECUTION_FAILED` with the same frames, and its cause carries `host_stack`.
- A `try` / `catch` with `rethrow: {}` keeps the inner frames plus the outer ones; a `throw` in `catch:` starts fresh and its `cause` keeps the inner frames; a retried step reports one attempt's frames.
- Kernel unit tests: a 100-deep self-dispatch gives 64 frames and `dropped_frames_count: 36`; a template body's entry is named with no position; `ERR_FATAL` carries `host_stack`.
- `pretty` encoder test: the same frames rendered with the working directory one level above the entry give `(app/users/telo.yaml:58:3)`, while `stack` keeps `(users/telo.yaml:58:3)`; a frame with an empty pointer has no `#`, one with no position no parentheses.
- OTLP encoder test: `exception.stacktrace` is the Telo trace, `telo.exception.host_stacktrace` present only for an uncoded failure.
- The `Http.Api.streamFailed` payload holds no `.mjs:` path for a coded failure.
- A `pkg:cargo` controller test on the Rust kernel: a panic gives `host_stack`, a structured refusal gives frames and none.
- `pnpm run check:controller-protocol` passes.
