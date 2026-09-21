---
"@telorun/studio": minor
---

The module graph no longer draws the module root. An Application's boot sequence (`targets:`) is shown instead as a marker on each resource it starts — its position in the boot order, drawn conditional for a gated entry with the `when:` on hover — and as an ordered Boot section in the module bar that lists every entry (bare, gated and inline invoke steps), reorders, removes and adds them. A resource whose kind may be booted offers "Start at boot" / "Don't start at boot" from its context menu. The Application's `logging:` block is edited from a Logging section in the module bar.
