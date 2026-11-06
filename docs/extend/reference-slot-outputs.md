---
sidebar_label: Reference Slot Outputs
slug: /extend/reference-slot-outputs
description: "Say where a referenced resource's output goes — into one input of a sibling slot's target — so telo check refuses a pairing whose shapes cannot meet."
---

# Reference slot outputs

Sometimes a kind dispatches one referenced resource and hands its result to
another. A mount's credential source reads a request and returns a
presentation, and the verifier beside it takes that presentation. Whether the two
fit is decided by their contracts, not by their kinds. `x-telo-ref` says so with
`outputTo`:

```yaml
verifiers:
  type: array
  items:
    type: object
    properties:
      verifier:
        x-telo-ref: { kind: Auth.Verifier, use: call }
      from:
        x-telo-ref:
          kind: Http.CredentialSource
          use: call
          outputTo: { slot: /verifier, member: presentation }
```

- `slot` is a JSON Pointer to a sibling reference slot. It is anchored like
  `inputs:` and a case map's `by:`: at the object enclosing the annotated slot,
  which is the list item here.
- `member` names a member of that slot's targets' input contract.

## What `telo check` judges

**At each resource**, the analyzer takes the source's declared output, resolved
as `steps.<name>.result` is typed (the instance's own `outputType`, then its
kind's along `extends`), and removes `null` from it: a source returning null
presents nothing. That output must fit the named member of the input contract
the sibling target resolves to. A definite mismatch is `CONTRACT_INPUTS_MISMATCH`
at the source's slot, naming both resources. A target that wants to refuse some
sources narrows its member to the variants it accepts. A side that declares no
contract gives no verdict.

**At the kind**, `X_TELO_REF_INVALID_OUTPUT_TO` is reported, for the entry's own
modules, in these cases:

- `outputTo` is not `{ slot, member }` with a pointer and a member name;
- the pointer names nothing in the enclosing object, names the slot itself, or
  names a field that is not a reference slot;
- a kind the target slot accepts declares no input contract;
- a kind the target slot accepts has an input contract with no such member.

## Runtime

The kernel adds no refusal of its own. It binds each target's input contract
when the resource is created, so a value that does not fit is refused when it is
dispatched, as `ERR_INPUT_INVALID`.
