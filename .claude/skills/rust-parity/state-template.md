# Rust parity campaign

## Charter

Decisions that bind every slice. Filled by the user, or by `decider` in a tick that ends right
after — the user corrects a line by editing it.

- **Goal:** every manifest test the Node suite passes passes on the Rust kernel; re-measured
  whenever `main` moves.
- **Controller hosting:** <how the Rust kernel runs a kind whose controller is written for Node>
- **Charter surface:** <public surface the charter's decisions approve the campaign to add>

### Build order

Taken in order, before any slice is picked from the ledger. Status: `pending` | `in-pr` |
`done`.

1. <step> — `pending`

## Now

- **Phase:** pick
- **Slice:** —
- **Branch / PR:** —
- **Head pushed:** —
- **CI fix rounds:** 0/2 · **Reruns at this head:** 0/1 · **Rebases:** 0 · **Ready announced:** no
- **Last seen feedback:** —
- **Consecutive fully-parked slices:** 0
- **Blocked on:** —
- **Last tick:** —
- **Last sweep:** — (`origin/main` sha · Rust <green>/<target> · Node <green>/<discovered>)

## Ledger

Rebuilt from each sweep. One entry per missing capability, in pick order. Status: `pending` |
`in-pr` | `merged` | `needs-human` | `rejected`.

- <capability> — unblocks <n> tests — `pending`

## For the user

What needs you, newest first: charter decisions, parked slices with their evidence, anything
labelled `needs-human`.

## History

One line per sweep, PR opened, PR merged or closed, and blocked or unblocked state.

- `<time>` campaign opened
