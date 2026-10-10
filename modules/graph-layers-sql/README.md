# Graph Layers SQL

The SQL family's shared half of a [layered knowledge graph](../graph-layers/README.md): the abstracts a SQL strategy module's kinds extend, the structural rules of a layered type, and the engine-neutral implementation, shipped as the code library `@telorun/graph-layers-sql`. It is written against `Sql.Connection` / `Sql.Table` / `Sql.Schema` and never names or branches on an engine.

You do not declare these kinds. An application imports a **strategy module** for its engine — [`graph-layers-current-sqlite`](../graph-layers-current-sqlite/README.md) / [`graph-layers-current-postgres`](../graph-layers-current-postgres/README.md) for layers with no versioning, [`graph-layers-drafts-sqlite`](../graph-layers-drafts-sqlite/README.md) / [`graph-layers-drafts-postgres`](../graph-layers-drafts-postgres/README.md) for layers edited in drafts, [`graph-layers-revisions-sqlite`](../graph-layers-revisions-sqlite/README.md) / [`graph-layers-revisions-postgres`](../graph-layers-revisions-postgres/README.md) for layers that keep every revision — whose concrete kinds extend these abstracts, inherit their rules and run these controllers.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `GraphLayersSql.Node` | Provider (abstract) | A node type over one layered table: `table`, `key`. |
| `GraphLayersSql.Relationship` | Provider (abstract) | A relationship type over one layered table: `table`, `source`, `target`, `sourceColumn`, `targetColumn`. |
| `GraphLayersSql.CurrentStore` | Provider (abstract) | One layer with no versioning: `connection`, `schema`, `layer`, `bases`, `nodes`, `relationships`. |
| `GraphLayersSql.DraftedStore` | Provider (abstract) | One layer edited in drafts: the same, plus the `layers` and `drafts` bookkeeping tables. |
| `GraphLayersSql.RevisionedStore` | Provider (abstract) | One layer that keeps every revision: `connection`, `schema`, `layer`, `nodes`, `relationships`, and the `layers`, `changesets` and `changesetBases` bookkeeping tables. No `bases`: what it is built on is pinned at run time and stored in `changesetBases`. |

## Docs

- [Layered tables, the rules, the statements and what a page costs](docs/layered-sql.md)
- [Drafted tables — rows, revisions, sessions, publish and rebase](docs/drafted-sql.md)
- [Revisioned tables — versions, changesets, pinned base lists, the index set, three-way merge, the pin-move pass and what each operation costs](docs/revisioned-sql.md)
