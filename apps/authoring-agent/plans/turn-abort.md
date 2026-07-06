# Turn abort endpoint (`POST /chat/{turnId}/abort`)

Lets a client end a running agent turn: the model call aborts immediately, the
journal gets its terminal (readers end), the conversation lease frees, and the
workspace stops changing.

## Already in place

- `Lease.Critical` supports `op: cancel` for detached bodies (`std/lease`,
  unreleased — the changeset/fragment ship with this branch). Cancelling the
  turn lease trips the detached body's cancellation token; `Ai.AgentStream`
  aborts the model connection, the failing stream makes `JournalSink` fail the
  journal key (readers get the terminal), and the lease releases on the body's
  terminal.
- The editor already calls `POST /chat/{turnId}/abort` from its Stop button and
  treats a 404 as "agent predates abort" (the turn then just runs out
  server-side).

## Remaining wiring — apply after `std/lease` releases with `op: cancel`

The chat library imports `std/lease` by registry pin, so this cannot land until
the release exists (registry pins resolve published copies, not the local
`modules/` tree).

1. `apps/authoring-agent/chat/telo.yaml`
   - bump `Lease: std/lease@<released version>`
   - export `chatAbort` and add:

   ```yaml
   # Abort a running turn: cancel the detached body under the conversation's
   # lease. The holder guard (holder == turnId) means a stale abort aimed at an
   # old turn cannot kill a newer one. The cancelled body's failing stream gives
   # the journal its terminal and the lease frees on the body's terminal.
   kind: Run.Sequence
   metadata: { name: chatAbort }
   inputs:
     conversationId: { type: string }
     turnId: { type: string }
   steps:
     - name: Cancel
       invoke: !ref turnLock
       inputs:
         op: cancel
         key: !cel "inputs.conversationId"
         holder: !cel "inputs.turnId"
   outputs:
     cancelled: !cel "steps.Cancel.result.cancelled"
   ```

2. `apps/authoring-agent/telo.yaml` — route:

   ```yaml
   - request:
       path: /chat/{turnId}/abort
       method: POST
       schema:
         params:
           type: object
           required: [turnId]
           properties:
             turnId: { type: string }
         body:
           type: object
           required: [conversationId]
           properties:
             conversationId: { type: string, format: uuid }
     handler: !ref Chat.chatAbort
     inputs:
       conversationId: !cel "request.body.conversationId"
       turnId: !cel "request.params.turnId"
     returns:
       - status: 200
         content:
           application/json:
             body:
               cancelled: !cel "result.cancelled"
     catches:
       - status: 500
         content:
           application/json:
             body:
               error: !cel "error.message"
   ```

3. Changie fragment: `changie new --project authoring-agent` (`Added`: abort
   endpoint).

## Notes

- Cancellation is process-local to the lease instance — fine here (one kernel
  per session container). A multi-instance deployment would need the cancel to
  reach the instance that dispatched the body.
- An aborted turn currently keeps its worst-case budget reservation (same as
  any errored turn); refund-on-error is a separate item.
