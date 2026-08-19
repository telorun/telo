# Zone attributes

One JSON file per attribute, read as one lexically ordered set. A **zone
attribute** is what an `x-telo-provides-zone` object form declares about the
region a body slot establishes: a property of everything executed inside it,
which a consumer of that region must respect.

```yaml
x-telo-provides-zone:
  key: /connection
  atomic: a rollback erases writes a journal recorded as done
  noSuspend: the transaction holds a connection a parked run would lose
```

The files live **here**, beside the language halves rather than inside either,
for the reason `sdk/value-types/` does: both kernels must agree on what the names
mean, and a vocabulary written in TypeScript is readable by one of them. JSON
because it is the only format all three runtimes embed with no generation step —
Rust has `include_str!`, Go has `//go:embed`, TypeScript has neither and only
`resolveJsonModule`.

`scripts/copy-zone-attribute-entries.mjs` (the root `prepare`) copies them into
`sdk/nodejs/src/zone-attributes/entries/` and emits the barrel from the same
directory listing, so a file that exists always loads.

## An entry

An entry declares a name, what its value must be, which other attributes it
implies, and **no code** — there is nothing per entry to implement, because the
meaning lives entirely with the consumer that reads it.

| key           | meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `name`        | The bare name an author writes as a key inside the annotation.               |
| `value`       | JSON Schema the declared value must satisfy. Always the author's **reason**. |
| `requires`    | Attributes that must be declared alongside this one.                         |
| `description` | What the diagnostic listing the vocabulary prints.                           |

**Each value is the reason, not a boolean.** Required by being the value itself
rather than a sibling of a `true`, so a diagnostic can quote the author's own
sentence — and so that `atomic: true` fails the declared schema rather than
reading as a valid declaration with nothing to say.

`requires` compiles to JSON Schema's `dependentRequired`, the standard keyword
for *if this property is present, those must be too*. That keeps the completeness
rule (`atomic ⇒ noSuspend`) in the data beside the thing it constrains rather
than as a hardcoded pair of names in a validator.

## The set is closed

Unlike `metadata.categories`, which is open precisely because **nothing branches
on it**, every zone attribute exists to be branched on and every reader is core.
A third-party attribute could only ever be half an attribute: a module cannot
contribute an analyzer pass, so it would get a runtime reader through
`ctx.zoneAttributes()` and no static check — while the failure directions that
justify validating this vocabulary at all are exactly the ones only a static
check catches. An unread `noSuspend` parks a run inside a lease; an unread
`atomic` journals a statement a rollback will erase.

Names are **bare, not `Telo.`-qualified**: the position already implies the
namespace, and with a closed set there is no second namespace to disambiguate
against. The cost, stated rather than hidden — reopening the vocabulary later
means a prefixed spelling and a migration, not a new key beside the old ones.

Adding an attribute is one file here plus a reader. The set is expected to reach
six (`deferred` for regions whose effects are not visible until exit,
`compensable` for sagas), which is what makes closing it cheap.
