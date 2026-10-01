# Lens: Module internals — core, ports, adapters

**Applies to** how one component is arranged inside: where rules, I/O, transports, transactions and
wiring sit. Builds on the architecture lens (between components), the DDD lens (what a boundary
contains) and the data-modeling lens (how data is stored).

## Principles, in ranking order

1. **Structure follows what the record carries — per aggregate or record type, not per component.**
   Business invariants or logic → a core that owns its ports and names no storage or transport
   kind. Integrity rules only → use cases use the store's generic abstract directly. One component
   may hold both.
2. **Decisions are pure; the use case does all I/O.** Load → decide → save. A decision takes loaded
   data and returns the new state, the events and the effects to perform. A read through a port is
   a load whether it reaches the component's own store or another system. In Telo a decision is a
   `Telo.Function` over the context's `Telo.Type`s — its determinism is derived, so purity is
   checked — and a use case is an invocable step flow that only invokes ports and calls decisions.
3. **A port is shaped by the core's need, one per collaborator role.** Storage: one repository per
   aggregate — load by ID, save whole. Outbound effects: one port per capability. Only the core's
   types and declared error codes cross it. In Telo a port is an abstract kind the component takes
   as a library `resources:` input (`Self.<Kind>` is a valid constraint); each operation is an
   invocable contract (`inputType`, `outputType`, `throws`).
4. **Every operation is a transport-neutral use case**, in both branches of principle 1. A handler
   only translates: `request` into the use case's inputs, its result and declared errors into the
   transport's response (`returns:` / `catches:`). The acting identity and the idempotency key
   arrive as input.
5. **The save is one port operation the adapter makes atomic** — new state with its expected
   version, the decision's events (outbox) and the idempotency key. The core's use case never sees
   a transaction; the atomic zone (`Sql.Transaction`) sits inside the adapter. A version conflict
   reruns the round. A layered record's use case uses the store's own atomic zone directly.
6. **Reads take their own path.** A query is a use case that changes nothing, applies no rule and
   loads no aggregate; in a core it reads through a port shaped by the answer. Source records or a
   read model behind it is the data-modeling lens's question. A command loads its own aggregate
   only through its repository.
7. **A contended invariant is enforced where the writers meet.** The aggregate is first cut down to
   what the invariant needs. A store-enforced conditional write, stated as one domain-named port
   operation with its outcome returned as data, is the only rule check allowed outside a decision.
8. **The application binds.** The component borrows every port and connection as a declared input;
   adapters live outside the core. A core imports no storage or transport module; a layered
   component imports the store's generic abstract and never a backend. One-import convenience is a
   separate wiring library exporting instances.

## Distinguishing questions

1. Does the record carry business invariants or logic, or only integrity rules?
2. Can the decision's reads be named before it runs?
3. Does a later read need an earlier read's value, or a rule's verdict?
4. Do independent actors compete to write this aggregate?
5. Is the contended check a comparison on the record's own fields?
6. Command, or query?

## Consequences

- **Invariants or logic** → core, ports, decisions; rules written in the store's vocabulary are
  disqualified. **Integrity only** → the store used directly; a port, repository or decision there
  is disqualified as a concept that models nothing.
- **Reads nameable up front** → one round, independent reads in parallel. **Needs an earlier read's
  value** → chained inside the same load phase; passing a field is not a round. **Needs a rule's
  verdict** → another round, each decision still pure; a loop when the count depends on the data.
  **Data only the store can walk** (a subtree, a path, a total over many rows) → one port operation
  the adapter answers whole; one read per element is disqualified.
- **Not contended** → the save's version check. **Contended, comparison on own fields** → the
  conditional write, idempotency key in the same atomic write. **Contended, richer rule** →
  commands processed one at a time per aggregate ID, answered asynchronously. Version-retry alone
  on a contended aggregate is disqualified; so is serializing or locking where a conditional write
  answers.
- **Command** → loads through the repository, one save. **Query** → no aggregate, no decision, no
  write. Finders on a repository, and a read model mirroring data that is not derived, are
  disqualified.

**Always:**
- A decision that calls a port, reads the clock, generates an ID or reads configuration is
  disqualified — the use case obtains these and passes them in.
- A rule restated in a use case's `if:` / `switch:` / `while:` condition is disqualified;
  conditions branch on a decision's result.
- A rule inside an adapter is disqualified, principle 7's conditional write excepted. Adapters
  only translate.
- A technology's error crossing a port is disqualified; the adapter translates into the port's
  declared `throws` codes, each classified retryable or terminal.
- A generic or query-language port is disqualified; so is one port per use case.
- Logic in a transport handler is disqualified, in a layered component too.
- In a core, a use case opening a transaction or unit of work is disqualified; a transaction per
  request is disqualified everywhere.
- No call to another system happens inside the atomic write.
- The storage shape and its migrations belong to the adapter, which maps to and from the core's
  types.
- A component that declares its own connections, imports a backend, chooses an adapter by a
  variable or looks one up by name at runtime is disqualified.
- Layout by technical layer (handlers / services / repositories) is disqualified; group by
  aggregate and use case, adapters beside them.

## Horizon

A second backend of a different kind behind a port (SQL → key/value → a remote service) · a second
and third transport for one operation · an aggregate moved to its own service · a plain record
gaining its first invariant · a use case replayed durably over days, or its decisions evaluated by
a second kernel language · 10× the writers on one aggregate · a new screen or report · a dependency
slow or down mid-command.

## Verify

1. A core's `imports:` name no storage or transport module; every port and connection arrives as a
   `resources:` input.
2. Supplying a different adapter — another backend, or an in-memory one — changes no decision and no
   use case, and the same tests pass.
3. Every decision gives the same output for the same input, asserted against a literal with no
   adapter running.
4. Exposing a use case on a second transport adds only a handler; no handler branches on business
   data.
5. Every condition in a use case's flow branches on a decision's result; none restates a rule.
6. A command performs one save; state, events and idempotency key are present together or absent
   together; no call to another system happens inside that write.
7. On a contended aggregate under concurrent writers, the invariant holds and throughput does not
   fall as load rises.
8. A query loads no aggregate; adding one changes no repository and no aggregate type.
9. A plain record has no port, repository or decision; an invariant-bearing aggregate's use cases
   contain no store operation.
10. Every error a use case branches on is a declared code of a port; no technology's error reaches
    the core.
