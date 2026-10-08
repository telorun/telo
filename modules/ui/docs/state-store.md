# Keeping a filter bar's state

A [filter bar](filters.md) with no `policy.state` keeps what the viewer chose
in memory: it is gone on a reload. `state` says where else it is kept.

```yaml
policy:
  state:
    key: todos
    address: true
    store: { kind: Ui.LocalStore }
```

| Key | | |
| --- | --- | --- |
| `key` | required | the name the state is kept under: a letter, then letters and digits |
| `address` | `false` | whether the filter values are part of the page's address |
| `store` | none | a `Ui.StateStore`, `!ref` or inline: where the state is stored between visits |

At least one of `address: true` and `store` is written; a `state` that keeps
nothing is a `SCHEMA_VIOLATION`.

- **In the address**, the values can be linked to, bookmarked and shared, and
  the browser's reload keeps them. Changing a filter replaces the current
  history entry; it never adds one.
- **In a store**, the values and the fold of a collapsible bar come back on the
  next visit with no trace in the address.

## Stores

| Kind | Keys | Keeps the state |
| --- | --- | --- |
| `Ui.LocalStore` | none | across sessions, for every tab of the application on that device |
| `Ui.SessionStore` | none | across a reload, for one tab; gone when the tab closes |

Both keep it in the viewer's browser; nothing is sent to the server.
`Ui.StateStore` is the abstract they extend — the bar's slot takes any kind
that extends it, so another place to keep state is another kind and the bar
does not change.

## One key, one state

Two bars declaring the same `key` share that state: what one writes, the other
starts from. That is how a bar on one page and a bar on another show the same
choice, and it is not an error. Give bars that should not share a `key` of
their own. A store's entries are kept apart per application: two applications
mounted under different paths of one origin never read each other's.

## Where a bar starts

1. The address, when the bar keeps state there and the address carries any of
   the bar's values.
2. Otherwise the store, when it holds an entry.
3. Otherwise each field's declared `default`.

With both written, every change goes to both.

A filter the viewer emptied stays recorded as empty, so a `default` they
cleared does not come back on the next visit; Reset is what restores it.

## What is read back is checked

A stored entry or an address can be older than the manifest. Each value read
back is held to what the bar declares now: a value for a property and operator
the bar no longer shows, one the property's type or `enum` refuses, or `false`
for a filter entered with a `toggle`, is dropped and what was kept is
rewritten without it. An address key that is no
declared filter's is left alone.

A browser that refuses storage — a private window, a blocked site, a full
quota that lets the store be read and not written — is reported once in its
console, and the bar goes on in memory.

## What a renderer receives

The `filters` node's `state` is `{ address, store, key? }`: `store` a
`Ui.StateStoreSpec` — `{ type: local | session | memory }`, `memory` for a bar
that names no store — and `key` present exactly when `state` was written. How
a renderer spells the address and the stored entry is its own:
[`ui-react`'s](../../ui-react/docs/urls.md#filter-state).
