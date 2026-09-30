# Lens: Architecture — coupling, cohesion, direction

**Applies to** where a responsibility lives, what may depend on what, and how components talk at
runtime — code structure (who imports whom) and runtime topology (who calls whom) alike. In Telo a
module is both.

## Principles, in ranking order

1. **Specific depends on generic, never the reverse.** Kernel/sdk ← generic modules ← specific
   modules ← applications.
2. **Knowledge flows through declared seams.** The specific side declares (annotation, registered
   extension, implemented abstract); the generic side reads it generically and never recognizes it
   by name. `x-telo-*` annotations are this pattern.
3. **No cycles at any scale** — files, packages, modules, services.
4. **Cohesion by domain capability.** One capability per component; what changes for the same
   reason lives together; each concept has one home. No `shared`, `common` or `utils` components —
   a component is named after the one behaviour or concept it owns.
5. **A contract is the only coupling across a boundary.** The owner defines its model and
   translates at the boundary. Contracts evolve additively; consumers ignore unknown fields.
6. **Synchronous depth ≤ 1.** Serving a request, a component makes at most one level of synchronous
   calls to other services, over any request/response protocol. Async messages do not count;
   parallel fan-out is depth one, bounded to a declared maximum; call cycles are forbidden.

## Distinguishing questions

1. Which side is more generic?
2. Inside one component, or across a boundary?
3. In-process, or over the network?
4. Synchronous, or asynchronous?
5. Does the caller need the result to answer?
6. Fact, or command?
7. Two components needing each other: shared concept, callback, or changing together?

## Consequences

- **Generic side** never names the specific one. Matching on a name, suffix or type string is
  disqualified.
- **Inside** → own store and internals used freely. **Across** →
  - only the owner's contract or its published read model; touching another component's storage
    is disqualified;
  - a contract exposing internal models, storage rows, internal IDs or a library's own errors and
    types is disqualified;
  - a change breaking consumers until they deploy together is disqualified;
  - one transaction spanning two components' stores is disqualified — saga with compensations, plus
    an outbox so a write and its event cannot diverge.
- **In-process** → fine-grained calls are fine. **Network** → coarse-grained (batch lookup, data
  included in the response); N calls per operation is disqualified.
- **Synchronous** → counts toward principle 6. Deeper needs are met by local read models fed by the
  owner's events, by parallel composition at the edge, or by moving work off the request path.
  Timeouts, retries and circuit breakers do not legitimize a deeper chain.
- **Result not needed** → event or queue, respond without it. Doing it on the request path is
  disqualified.
- **Fact** → published without knowing subscribers; a publisher addressing consumers is
  disqualified. **Command** → addressed to exactly one owner.
- **Breaking a cycle:** shared concept → extract it into a lower component named after it;
  callback → invert through a seam the lower side declares; changing together → merge.

**Always:** a typical change touching several components means the boundary is misplaced;
consumers using only part of a component means it holds two capabilities.

## Horizon

A second and third consumer of a generic component · another service on the request path · a
component changing its storage or internals · each component releasing on its own schedule · 10×
load or one slow dependency · a library moved out of process · a new subscriber to an event.

## Verify

1. The import and call graph has no cycle and no edge from generic to specific.
2. The generic side names no specific component, kind or consumer.
3. A typical change to the capability touches one component.
4. Each component releases alone against its neighbours' previous release.
5. Every request path has synchronous depth ≤ 1 with bounded fan-out.
6. No component reads another's store; no contract exposes internal models, IDs or library types.
7. Adding or removing a subscriber changes nothing in the publisher.
