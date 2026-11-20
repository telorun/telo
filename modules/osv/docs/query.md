# Osv.Query

An invocable that looks up known vulnerabilities for a list of components.

```yaml
kind: Telo.Application
metadata:
  name: AdvisoryCheck
  version: 1.0.0
imports:
  Osv: ../
targets:
  - name: query
    invoke: { kind: Osv.Query }
    inputs:
      components:
        - { purl: pkg:npm/%40fastify/static, version: 10.1.0 }
        - { purl: pkg:generic/sqlite, version: 3.51.3 }
        - purl: pkg:generic/sqlite
          version: 3.51.3
          vcs: { url: "git+https://github.com/sqlite/sqlite", revision: a5333afb9ad1aa473f8963b92caeaa955f47dc74 }
```

## Configuration

| Field | Meaning |
| --- | --- |
| `baseUrl` | The OSV endpoint, http or https. Default `https://api.osv.dev`; point it at a mirror or a stand-in. |

## Input

`components`: a list of `{ purl, version, vcs? }`. The `purl` has no version and no `vcs_url` qualifier (`package-url` format, which refuses either); the `version` is the exact one in use. `vcs` is `{ url, revision }`, the git repository (`vcs-url` format, `git+https://…`) and the full commit (`vcs-revision` format) the component is built from — how embedded C code, which no package registry versions, is checked. The caller bounds the list: every call sends it whole, and the lookup splits it into OSV's batch size and follows OSV's page tokens itself.

**The caller proves the revision.** That the commit is in the repository's history is not something OSV can answer — a host such as GitHub serves a fork's commit through every repository of the fork network — so pass a `vcs` only once it is proven, as `telo publish` does before recording one in a module's bill of materials.

## Output

`components`, one entry per input in order:

- `purl`, `version` and `vcs` as given.
- `checked`: whether OSV judged the component — by its package type (`pkg:npm`, `pkg:cargo`, …), or by its revision when `vcs` names a git repository OSV names in at least one record. Coverage is decided by repository: one probe per distinct repository (a package query with no version), then a commit query per component. A `pkg:generic` component with no `vcs`, or one whose repository OSV records nothing about (a fork, say), is unchecked: its empty `advisories` is no verdict.
- `advisories`: each `{ id, aliases, summary, severity, component, fixed, matchedBy }`. `severity` is `{ type, score }` as OSV records it and may be empty; `component` is the purl with its version appended; `fixed` is the versions that fix it for that package or, for an advisory matched by revision alone, the commits of the component's repository that fix it. `matchedBy` is `version` when the package and version matched the advisory and `revision` when only the component's commit did, so a caller words its fix as a version or as a commit.

## Failure

When OSV gives no answer — a timeout, a refused connection, a 429 or a 5xx, retried up to 4 attempts of 30 s each within 120 s for the call, or any refusal retrying cannot change — the invocation fails with `ADVISORY_LOOKUP_FAILED`, its `data.endpoint` naming the request. One failed request fails the whole call: there are no partial answers.

A cancelled invocation (a caller's deadline or a stopping application) stops the lookup at once, mid-request or mid-backoff, and fails with `ERR_INVOKE_CANCELLED` rather than `ADVISORY_LOOKUP_FAILED`.
