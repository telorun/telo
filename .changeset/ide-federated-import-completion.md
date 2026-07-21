---
"@telorun/ide-support": minor
---

Import-source autocomplete is now federated and ref-keyed: the
`IdeEnvironmentAdapter` speaks the telo hub's `/refs` (fuzzy ref search) and
`/module/versions` verbs instead of a single registry's `namespace/name` API.

`searchRegistry` / `listRegistryVersions` are replaced by `searchRefs(query)`
(returning `HubRef { ref, latestVersion, description? }`) and
`listVersionsForRef(ref)` — an OCI module has no addressable `namespace/name`,
so completion is keyed on the location ref. `importSourceCompletions` routes a
bare word or an `oci://…` prefix to hub ref search (passing the whole prefix as
the query, which fixes the prior `oci://` fall-through that mangled `//ghcr.io/…`
into the registry query) and a `<ref>@<partial>` prefix to the ref's version
list. `RegistryModule` is removed from the public types.

Hosts (`@telorun/editor`, `@telorun/vscode-extension`) implement the ref-keyed
adapter against their configured hub, mirroring the CLI's
`TELO_HUB_URL` / `--hub-url` convention (default `https://telo.sh`).

Completion labels show the `org/name@version` tail (`telorun/console@1.2.3`)
rather than the full `oci://ghcr.io/…` ref, so the interesting part isn't
truncated behind the transport/host boilerplate; the full ref moves to the item
detail and is still what gets inserted. Version completions show just the
version.
