---
"@telorun/sdk": minor
---

`turnStepPath` — the journal prefix for one turn of a composer that drives its
own body.

A composer running its body N times journals under the prefix the kernel hands
it for the whole dispatch. Sharing that one prefix across turns is not merely
imprecise: the journal takes the first writer at a key, so turns 2..N found a
record already there and replayed turn 1's outcome instead of executing — work
silently skipped, run still successful. The step engine's own `while` already
qualified each turn this way; a controller driving the body itself now has one
spelling to reach for rather than three.
