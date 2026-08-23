---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

One schema-error renderer, and a failing union now reports the branch you meant.

A schema failure used to be rendered three ways — the analyzer's keyword prose,
the kernel's raw `instancePath + message` join, and observed state's own inline
variant — so fixing what `telo check` told you led to a different sentence
describing the same failure at runtime. The analyzer's implementation is now the
only one; the kernel's copy and the observed-state variant call it.

Neither renderer handled `anyOf` / `oneOf`. Both joined the entire AJV error
array, so a failing union emitted every branch's complaints concatenated with
nothing saying which branch was meant — already live for `Fs.FileWrite`'s
`content`, and about to become an authoring surface for any vocabulary
discriminated by which key is present.

Union reduction selects the branch the value plainly is: branches complaining at
the union's own node (a missing discriminating key, a forbidden key, a wrong
type) are not plausible readings, and among the rest the one that agreed
furthest into the value wins. It narrows the error SET rather than the sentence,
so a union failure is one diagnostic on one line instead of one per branch on
different lines, and it is recursive — an inner union inside the selected branch
is reduced in turn, which is what a self-recursive shape needs, since every
level of one carries the identical `schemaPath` and only `instancePath` tells
them apart.

When no branch is a plausible reading it says so and names the alternatives by
their discriminating keys, rather than presenting one branch's complaints as
though it were the intended one:

```
/content matches no alternative — expected one with 'text', or one with 'table'
```

A branch participates by declaring its discriminating key as `required` — that
is what selection reads, off the errors alone rather than off the schema, which
is what lets it work across a `$ref` into another registered schema. A union
whose branches declare no such key still gets the alternatives listing, never a
wrong guess.

This is not fixable inside AJV: a union must attempt every branch, and
`discriminator: true` works only against an explicit OpenAPI-style discriminator
property, which would mean changing what every module's authors write.

No manifest surface changes.
