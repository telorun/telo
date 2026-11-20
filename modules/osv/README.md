# Osv

Known-vulnerability lookup for software components, against the [OSV](https://osv.dev) database.

## Why use this

- **Advisories per component** — give package URLs with exact versions, get each component's advisories with severity, aliases and fixed versions.
- **Embedded C code by commit** — give the git repository and commit a component is built from (`vcs`), and it is checked against the advisories recorded for that repository's commits.
- **An honest answer** — each component says whether it was checked (`checked`), by its package type or by a revision of a repository the database records; an unchecked component is not clean.
- **Retries built in** — timeouts, refused connections, 429 and 5xx are retried with backoff; if the database still gives no answer the call fails and no component is judged.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Osv.Query` | Look up a list of `{ purl, version, vcs? }` components and return each with `checked` and `advisories`. |

See [docs/query.md](docs/query.md).
