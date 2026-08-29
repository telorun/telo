# An inheriting child's own fields are held and never published

## Problem

A `Telo.Definition` may specialize a **concrete** kind. When it declares no `base:`,
its author-facing schema is `merge(parent, own)` — pure additive extension — so it may
declare fields the parent never had. When it also declares no `controllers:` and no
template body, it inherits the parent's controller by delegation: the kernel forwards
the child's whole config to the parent kind's `create()` and **returns that instance
verbatim**. The child *is* a parent instance.

Those two rules are individually right and together leave a hole. The parent
controller HOLDS the child's added field — it arrives in the forwarded config — but the
published reading is whatever the parent's `snapshot()` picks, and a controller picks
the fields its own schema names. So a field the child declares and an author fills
validates, is held, and is published nowhere: `resources.<child>.<field>` evaluates to
nothing at runtime, and `telo check` says nothing, because the flat half of every
resource's reading is open (no manifest declares what a `snapshot()` returns).

That is the swallow-by-silence shape the runtime otherwise designs out, and it leaves
concrete inheritance half a feature: without `base:` a child can widen a schema but can
never carry new meaning. Found while designing an OpenAI account resource that
specialized `Http.Client` to add one dialect field
(`modules/ai/plans/declarative-model-contract.md`).

A second failure sits beside it: a parent whose schema is **closed**
(`additionalProperties: false`) rejects the forwarded field at the parent's own
create-time validation. Loud rather than silent, but it fails at boot with a message
phrased against the parent kind, at the instance's line, about a synthesized resource
the author never wrote — and `telo check` says nothing. Adding fields is the point of
the merge form, so this stops being a corner and becomes the second thing an author
hits.

**Before.** A child adds a field; it validates, the parent holds it, nothing publishes
it, no diagnostic.
**After.** The field is published beside the parent's reading, so
`resources.<child>.<field>` and `self.<ref>.<field>` resolve at runtime — and where
the parent's schema is closed, `telo check` says so at the property that must change,
rather than the kernel failing at boot about someone else's kind.

## Solution

The **publication path** joins the child's own configured fields into the reading it
builds, next to where it already folds the kind's `status:` contract in. It reaches the
definition exactly as that does, so nothing is bound onto the instance: rebinding
`snapshot()` would be a JS-only trick a second kernel cannot reproduce, and it would
install a `snapshot` on instances that have none — which other code uses as a liveness
test to tell a live instance from a raw manifest. This is configured state, pulled from
config the kernel already validated against the merged schema; observed state is
unchanged, so a child declaring `status:` still reports through the parent instance's
`ctx.setStatus`.

Scope is exactly the combination that is broken today: a concrete-`extends` child with
**no `base:`** (so its schema is the additive merge) and **no own controller or
template body** (so it is the parent instance verbatim). A `base:`-form child is
untouched — its fields are construction inputs consumed by the mapping and do not exist
on the instance. A child with its own controller is untouched; its controller
publishes.

Which fields: those the child's effective schema declares **that the ancestor's does
not**. A redeclared name is excluded, and that is the load-bearing half — narrowing an
inherited field (a description, a pattern, a widget hint) is ordinary in an additive
extension and says nothing about publication, while the parent's `snapshot()` is the
sole authority on what a parent instance publishes: its normalizations, its deliberate
omissions, and its redactions. Republishing a redeclared field from raw config would
silently undo a provider's decision to keep it out of the CEL scope, the `Created`
event and `--debug`.

The set is computed once and **stamped onto the definition at registration**, in the
scope that declared the `extends` alias — the reason `status:` is stamped there rather
than resolved at read time: the module doing the reading may have no alias for the
parent's library.

Two values are withheld even for an own field, because neither is a reading: a slot
declared `x-telo-eval: runtime` still holds an unevaluated expression when the reading
is taken, and publishing it would put the compiled-value sentinel in the CEL scope
under a slot typed `string`; and a value holding a live resource instance is a
collaborator. Withholding is the conservative direction — such a field reads as it did
before this change rather than as a wrong value.

Separately, a merge-form child of a **closed** parent is rejected statically, at the
child's own property, naming the closed ancestor and pointing at `base:`. The rule is
decidable from the definitions alone, and every primitive it needs already exists.

The analyzer's **typing** is unchanged. The flat half of `resources.<name>` is
deliberately open, so `resources.<child>.<field>` already types today; closing it from
a kind's schema would be a separate change affecting every resource, not this one.

## Decisions

- **Publish, rather than forbid.** A diagnostic rejecting a controller-less
  merge-form child with fields nothing reads converts a silent trap into a loud one but
  forbids something that ought to work. Publishing makes the mechanism whole.
- **Joined at publication, not bound onto the instance.** The publication path already
  reads definition-derived data, so it holds both halves; binding would also be
  language-specific and would forge a liveness signal other code reads.
- **The difference, not every name the child mentions.** The cheaper set is every
  property of the child's own schema, but that republishes a field a provider
  deliberately withheld the moment someone narrows its description.

## Verify

`tests/inherited-child-fields.yaml` asserts the whole reading of two merge-form
children, with no network in the sequence — publication is a function of config, and
gating it behind a live request would take the coverage down with any outage. One
child's added field publishes beside the parent's reading while an unset inherited
field keeps the parent's default; the other's runtime-eval field and redeclared
inherited field are both absent, and its parent declares no `snapshot()` at all, so
own-field publication cannot rely on there being one. The closed-parent diagnostic is
asserted to fire at the child's property. The `base:`-form test asserts its
construction field is still NOT published, so the narrowing cannot drift.

## Release

Publication is a kernel behaviour, not manifest syntax, so no `requires:` floor
applies and none can be verified: an older CLI's `check` accepts the manifest either
way, and a floor the verification procedure cannot refute is a claim nothing checks. On
an older kernel a manifest reading such a field gets nothing, and `requires:` has no
way to say so. The publication half is additive: every existing manifest publishes what
it published before, since none can be reading a field that was never available.

The closed-parent diagnostic is a **new error**, and one that can fire on a manifest
that checked clean before. It is not a new restriction: every manifest it rejects
already failed at boot, so what changes is when and where it is reported. It is scoped
to the entry's own modules by the pass it lives in, so a published dependency's kinds
cannot fail a consumer's check.
