# Ui.CollectionSource

A collection as the browser reaches it: the declared
[collection](https://hub.telo.run/module/oci/ghcr.io/telorun/data-model/) — what a record is, its key,
and the filters, sort orders and facets its list request accepts — and where
its list endpoint is.

| Field | | |
| --- | --- | --- |
| `collection` | required | the `DataModel.Collection` read — or a kind extending it — `!ref` or inline |
| `basePath` | required | [app-relative](nodes.md#addresses) URL of the collection: a literal with no `{` or `}`, or `{ path, pathParams }` — see [A templated base path](#a-templated-base-path) |

```yaml
kind: Ui.CollectionSource
metadata: { name: authorsSource }
collection: !ref authors
basePath: /api/authors
```

Whatever serves `basePath` speaks
[the collection contract](https://hub.telo.run/module/oci/ghcr.io/telorun/data-model/). One
authors URL written once is used by every screen over authors and by every
picker of an author: a [presentation](collection-presentation.md) of authors, a
relation pointing at authors, and a
[`Ui.CollectionOptions`](field-kinds.md#option-sources) all name the same
source.

A source carries no relations, so an option source reading it can never form
a cycle. A kind narrowing `collection` to a kind extending
`DataModel.Collection` extends this one.

A write, a delete, a row action, `notifyChanged(basePath)` and an action's
`onSuccess.refreshes` resolving to the source's `basePath` reload every listing over
it, and every facet request over it.

## A templated base path

A collection served under another record — a runner's commands — is addressed
by a template whose `{name}` segments `pathParams` fills from the page's
[`params`](page.md#params) or `query`; a source has no row.

```yaml
kind: Ui.CollectionSource
metadata: { name: runnerCommands }
collection: !ref commands
basePath:
  path: "/api/runners/{name}/commands"
  pathParams: { name: !cel "params.name" }
```

- Every `{name}` has exactly one entry in `pathParams` and every entry names a
  `{name}` (`PATH_PARAMETER_UNBOUND`, `PATH_PARAMETER_UNUSED`). A read of a
  variable a page placing the source lacks is `CEL_UNKNOWN_FIELD` naming that
  page, through the listing and presentation placing it.
- The browser resolves the template as it resolves an
  [address](nodes.md#addresses). A value that holds nothing sends no request,
  and the node reading the source draws its `failure`.
- Invalidation matches the resolved path: a write under
  `/api/runners/a/commands` reloads runner `a`'s listing and not runner `b`'s.

What a renderer receives as `basePath` — on a listing, a form, a filter bar
and an option source — is the literal string, or
`{ path, pathParams }` with `path` the template and each parameter a binding.
