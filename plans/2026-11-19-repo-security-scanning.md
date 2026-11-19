---
status: done
priority: high
depends-on: []
packages: [modules/http-server, modules/mcp-client, apps/docker-runner, apps/k8s-runner, analyzer, .github]
refinement: not-started
---

# Security scanning for Telo's own dependencies, code and images

## Problem

Nothing scans the repository. There is no audit step, no CodeQL, no Dependabot or
Renovate, no `cargo-deny`, no image scanning and no `SECURITY.md`. Secret scanning,
push protection and Dependabot security updates are all disabled on `telorun/telo`.

`pnpm audit` over `pnpm-lock.yaml` reports **274 advisories: 7 critical, 98 high,
136 moderate, 33 low**. 5 critical and 87 high remain once dev dependencies are
excluded. Neither `Cargo.lock` (the root one or Studio's Tauri one) has ever been
scanned. Several advisories reach users or runner hosts today:

- `@fastify/static` 8.3.0, path traversal that bypasses route guards. It ships in
  `http-server` to every application serving `Http.Static`.
- `fastify` 5.12.1 (authentication bypass, validation bypass) and `@grpc/grpc-js`
  1.14.3 (server crash) in the docker runner.
- `@modelcontextprotocol/sdk` 1.29.0 (OAuth credentials sent to the wrong server,
  no request size limit), with `proxy-addr` (critical) and `hono` beneath it, in
  `mcp-client`.
- `fast-uri` (host confusion, SSRF) under `ajv` in the analyzer and the docker
  runner.
- `form-data` (CRLF injection) and `ip-address` in the k8s runner.

CI is also exposed. No action is pinned to a commit, versions are mixed
(`pnpm/action-setup@v2` beside `@v4`, `actions/cache@v3`), and pnpm installs a version
minutes after it is published. Published images carry no SBOM or provenance, and npm
packages are published without provenance.

## Constraints

None.

## Surface

**Added**

- `SECURITY.md`: the disclosure policy, pointing at GitHub private vulnerability reporting.
- `osv-scanner.toml`: suppressions for npm and Cargo advisories; each entry has `id`, `reason` and `effectiveUntil`.
- `deny.toml`: `cargo-deny` configuration covering advisories, bans and sources (no licenses); `advisories.ignore` mirrors the Rust entries of `osv-scanner.toml`.
- `.trivyignore.yaml`: image suppressions; each entry has `id`, `statement` and `expired_at`.
- `renovate.json`: the Renovate configuration.
- `pnpm-workspace.yaml` `minimumReleaseAge: 4320` and `minimumReleaseAgeExclude: ["@telorun/*"]`.
- `pnpm run check:suppressions`: the CI check that enforces the suppression rule.
- `.github/workflows/security.yml`: OSV-Scanner, `cargo-deny`, zizmor and the suppression check.
- `.github/workflows/codeql.yml`: CodeQL for JavaScript/TypeScript, Rust and Actions.
- `.github/workflows/renovate.yml`: Renovate as a scheduled GitHub Actions workflow on GitHub's runners (the Renovate CLI run on the runner beside a workspace-built `telo`, GitHub App token); nothing runs on anyone's machine. Bot-level options (the repository list, the allowed post-upgrade commands) are `RENOVATE_*` environment variables in this workflow, not keys of `renovate.json`.
- Code-scanning categories in the Security tab: `osv-scanner`, `cargo-deny/.` and `cargo-deny/apps/studio/src-tauri`, `zizmor`, `trivy/<image repository>[/<variant>]`, and CodeQL's own `/language:javascript-typescript`, `/language:rust`, `/language:actions`. The PR run of OSV-Scanner uploads the whole-tree result under `osv-scanner` and gates on the diff, so no `main` alert reads as fixed on a PR.
- The root suppression files reach both Cargo workspaces and Studio's lockfile because `security.yml` passes them explicitly (`--config` to OSV-Scanner and `cargo-deny`, `--ignorefile` to Trivy).
- Repository variable `RENOVATE_APP_ID` and repository secret `RENOVATE_APP_PRIVATE_KEY`.

**Changed**

- Every published Docker image carries a buildx SBOM and provenance attestation, and is refused before push by a fixable Critical or High finding.
- Every published npm package carries npm provenance.
- Every third-party action in `.github/workflows/` and `.github/actions/` is pinned to a commit SHA, with the version in a trailing comment.

**Removed**

None.

## Solution

**1. Fix the user-facing advisories.** Bump `@fastify/static` 8 → 10 in `http-server`.
This is the one major upgrade the user approved, because no 8.x release carries the
fix. Bump `fastify` to ≥5.12.5, `@modelcontextprotocol/sdk` to ≥1.32.0, and the
transitive `hono`, `proxy-addr`, `fast-uri`, `@grpc/grpc-js`, `form-data` and
`ip-address` to their patched minors and patches. Use pnpm `overrides` where a parent
pins an old range. Each touched unit ships a `Security` fragment through
`telo release add`. `http-server` is re-tested against its `Http.Static` suite, since
`@fastify/static` 10 is the API change.

**2. Clear the backlog before the full-scan gate turns on.** Every other advisory in
both ecosystems is fixed within minor or patch ranges, mostly through one lockfile
refresh. The rest get an individual suppression entry. The change that turns on the
scheduled full-scan gate leaves the full scan green.

**3. One suppression rule for every scanner.** An entry names one advisory id. Its
reason says which case applies (no fix exists, the fix exists only in a major, or the
vulnerable code is not reached) and what would end the entry. Its expiry is at most
90 days ahead. No package-wide ignores. `pnpm run check:suppressions` enforces the
fields and the ceiling, and that `deny.toml` mirrors the Rust entries of
`osv-scanner.toml`. An expired entry makes the next scan fail by itself. A dismissal
in the Security tab never passes a gate; only these files do.

**4. Scanners and gates.** `security.yml` runs:

- OSV-Scanner in PR-diff mode over `pnpm-lock.yaml` and both `Cargo.lock` files, on
  every PR that changes a lockfile or a suppression file. Only an advisory the PR
  introduces fails it.
- The same scanner over the whole tree, daily and on every push to `main`. This run
  fails on any advisory that is not suppressed.
- `cargo-deny` over both Cargo workspaces.
- zizmor over the workflows.

`codeql.yml` runs on every PR, every push to `main` and weekly. It is not narrowed by
CI's test selection, because the required check needs a result for every language on
every PR. It blocks at High or higher for security alerts and at error level
otherwise. Every scanner uploads SARIF under its own category for the record. The
gate is each job's exit status, plus code scanning's own PR check for CodeQL. The new
checks become required checks.

**5. Renovate.** `renovate.yml` runs Renovate on a schedule, authenticated by a
dedicated GitHub App token so its PRs start checks. It:

- disables majors for every manager: npm, cargo, Dockerfile, Helm and github-actions;
- pins action and base-image digests;
- waits 3 days after publication, except for `@telorun/*`;
- refreshes the lockfile weekly;
- tracks `sources:` versions through a custom manager;
- runs `telo release stage --pin` after a staged-source update, and
  `telo release add` (`Security` for an advisory fix, `Fixed` otherwise) for each unit
  an update reaches.

Every Renovate PR therefore passes `telo release check` as opened.

**6. CI and supply-chain hardening.**

- Pin every third-party action to a SHA and unify the mixed versions within their
  current majors.
- Give every workflow a top-level `permissions:` block with least privilege.
- Set pnpm's `minimumReleaseAge`. A security fix younger than 3 days gets one named
  exclude entry, with its advisory id in a comment, removed once the window passes.

**7. Published artifacts.**

- Each image build scans its image with Trivy before push. A Critical or High finding
  with a fix available stops the release; unfixed and moderate findings are recorded
  only.
- buildx writes SBOM and provenance attestations for every pushed image.
- The npm publish job publishes with provenance through the job's OIDC token
  (`id-token: write`).

`RELEASING.md` gains the Trivy refusal and how to recover from it: rebuild on a
patched base digest, or add a suppression.

**8. Manual steps for an org admin**, listed in the PR description:

- create the Renovate GitHub App and store its id and key;
- turn on secret scanning with push protection;
- turn on private vulnerability reporting;
- mark the new checks as required on `main` and `release/*`;
- set code scanning merge protection to High or higher for security alerts, errors otherwise.

**Verify**

- A PR adding a dependency version with a known advisory fails `security.yml` and
  shows the alert inline. Dismissing the alert in the UI leaves the job red.
- The scheduled full scan on `main` is green on the day this lands, and red the day
  after any entry's `effectiveUntil`.
- `pnpm audit --prod` no longer lists any advisory from the Problem section.
- A Renovate PR bumping a staged source carries re-pinned `sha256` values and a
  fragment, and passes `telo release check`.
- Installing a version published an hour ago fails, while an `@telorun` candidate
  installs.
- An image with a fixable High finding is not pushed. `docker buildx imagetools inspect`
  of a published image shows its SBOM and provenance. `npm view` of a published
  package shows provenance.
- Every PR shows CodeQL results for all three languages.

## Decisions

- **The scanners consume lockfiles; no Telo-owned scanner.** OSV-Scanner reads
  pnpm and Cargo lockfiles in one tool and has a PR-diff mode. `pnpm audit` covers
  npm only.
- **The full scan gates too, after the backlog is cleared.** Diff mode alone never
  forces an existing advisory to be addressed. Suppressions with an expiry make "known
  and accepted" explicit and temporary.
- **Renovate as our own workflow on GitHub's runners, over Dependabot or Mend's hosted
  Renovate app.** Only a run we control can execute post-upgrade commands, so only it
  can add the release fragment and re-pin `sources:` inside the update PR. Without
  them a PR fails `telo release check` or ships an unattributed patch.
- **A dedicated GitHub App token, not `TELO_BOT_TOKEN`.** A separate identity keeps
  Renovate's write scope apart from the release bot's.
- **SARIF for the record, exit status for the gate.** SARIF alone blocks nothing, and
  job failures alone leave no per-alert history.
- **Trivy blocks on fixable Critical/High only.** A fixable finding is actionable by a
  rebuild. Blocking on unfixed base-image findings would make every release depend on
  Debian's schedule.
- **3-day release age.** It matches npm's 72-hour unpublish window, after which a
  version is stable. `@telorun/*` is excluded because the release flow installs fresh
  candidates of its own packages.
- **`cargo-deny` skips licenses.** `pnpm run check:licenses` already owns licensing.
