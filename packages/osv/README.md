# @telorun/osv

The OSV advisory lookup Telo's tools share. It owns the package types OSV matches by version, the version control tools it matches commits of, the batched query, the retries and each component's `checked` answer, so the `telo audit` command and the `osv` standard-library module (`Osv.Query`) judge the same components the same way.

It uses only `fetch`.

## API

```ts
import { lookupAdvisories, AdvisoryLookupError, isChecked } from "@telorun/osv";

const answers = await lookupAdvisories(
  [
    { purl: "pkg:npm/%40fastify/static", version: "10.1.0" },
    { purl: "pkg:generic/sqlite", version: "3.51.3" },
    {
      purl: "pkg:generic/sqlite",
      version: "3.51.3",
      vcs: { url: "git+https://github.com/sqlite/sqlite", revision: "a5333afb9ad1aa473f8963b92caeaa955f47dc74" },
    },
  ],
  { baseUrl: "https://api.osv.dev" },
);
```

`lookupAdvisories(components, options?)` takes components `{ purl, version, vcs? }` whose `purl` carries no version and no `vcs_url` qualifier, and resolves with one answer per input, in order:

- `purl`, `version` and `vcs` as given.
- `checked`: `true` when OSV matches the package type by version, or matches the component's revision — `vcs` names a tool OSV matches commits of (`git`) and a repository OSV names in at least one record. Otherwise the component is not judged: `checked` is `false` and `advisories` empty, which is not a clean verdict.
- `advisories`: one item per advisory, `{ id, aliases, summary, severity, component, fixed, matchedBy }`. `severity` is `{ type, score }[]` as OSV records it and may be empty; `component` is `purl@version`; `fixed` lists the versions of that package the advisory's affected ranges fix, or, for an advisory matched by the revision alone, the `fixed` commits of the `GIT` ranges recorded against the component's repository. `matchedBy` says which: `version` when the package-and-version query named the advisory, `revision` when only the commit query did.

**A revision is the caller's to prove.** That `vcs.revision` is a commit of `vcs.url` — reachable from one of its branches or tags — is not something OSV can tell: a host such as GitHub answers a fork's commit through every repository of the fork network. `telo publish` proves it before writing a record, and `telo audit` for a module on disk; this package only reads OSV.

Options: `baseUrl` (default `https://api.osv.dev`), and, for tests, `fetch`, `sleep`, `now` and `random`.

Queries go to `<baseUrl>/v1/querybatch` in requests of at most 1000 (`BATCH_LIMIT`), each query's `next_page_token` followed until none is left; each distinct advisory's full record is then read from `<baseUrl>/v1/vulns/<id>`. Components with `vcs` first cost one probe per distinct repository — a package query with no version, `{ package: { ecosystem: "GIT", name: <url without "git+"> } }`, whose first page naming a record is enough — then a commit query, `{ commit: <revision> }`, per component of a recorded repository, beside its purl query when its package type is matched too. A failed probe fails the lookup like any other request.

### Retries and failure

A request is retried on a timeout, a failed connection, a 429 (waiting `Retry-After`) or a 5xx, with jittered exponential backoff: at most 4 attempts (`MAX_ATTEMPTS`), 30 s each (`ATTEMPT_TIMEOUT_MS`), 120 s for the whole lookup (`LOOKUP_BUDGET_MS`). Any other refusal fails at once. A failure rejects the whole call with an `AdvisoryLookupError` (`code` `ADVISORY_LOOKUP_FAILED`) carrying `endpoint`, `attempts` and `detail` (the cause), so no component is ever reported clean from a partial answer.

### Package types

`OSV_ECOSYSTEMS` maps a purl type to the OSV ecosystem its advisories are filed under (`npm`, `cargo`, `pypi`, `golang`, `maven`, `nuget`, `gem`, `composer`, `hex`, `pub`). `isChecked(purl)` reads it, so adding a type there changes the `checked` answer everywhere. `purlType` and `osvPackageName` are the helpers the lookup uses.

`OSV_VCS_ECOSYSTEMS` maps the tool a VCS location names (`git` of `git+https://…`) to the OSV ecosystem its repositories are recorded under (`GIT`); `vcsTool`, `vcsRepository`, `vcsEcosystem` and `sameRepository` read it; `vcsRepository` answers the repository as OSV writes it — no `<tool>+`, no trailing `/` or `.git`, scheme and host lower-cased — so two spellings of one repository are one probe. Adding a tool there changes which components can be checked by revision, in `telo audit` and in the hub, with no other edit.

The package does not validate purls: a `purl` naming a version is queried as given with the version appended. Callers validate with the `package-url` format.
