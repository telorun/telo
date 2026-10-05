# Cloud Workspaces

## Problem

Studio has no notion of a user. A workspace is a folder on the user's machine or
a copy in the browser's `localStorage`; it cannot be opened from a second device
or by a colleague, and the only way to get an application deployed by Telo Cloud
is to leave Studio, run `telo publish` against a public registry and paste the
ref into the Cloud console.

Telo Cloud already has workspaces (members, roles, apps, deployments) but they
hold no files. This plan lets a signed-in user open a Telo Cloud workspace in
Studio, edit it, commit to its git repository and publish a module so Cloud can
deploy it. Signing in is optional: everything Studio does today keeps working
anonymously.

Out of scope: usage limits, creating workspaces or connecting repositories
(done in the Cloud console), opening pull requests, deploying from Studio.

## Solution

Studio talks to one service, the Telo Cloud API, and never to a git host, an OCI
registry or the identity provider's token endpoint from JavaScript. A Cloud
workspace is edited in a local working copy; committing sends the difference to
Cloud together with the commit it was based on.

### The rule both builds obey

Studio's JavaScript never holds a token, in memory or in storage. Neither build
depends on CORS. All Cloud calls go through one transport with two
implementations chosen by build target; no other code knows which is active.

| | Web (`studio.telo.run`) | Desktop |
| --- | --- | --- |
| API base | `/api` on Studio's own origin | build setting `VITE_TELO_CLOUD_API_URL`, default `https://console.telo.cloud/api` |
| Credential | cookie `__Host-sid`, set by Cloud, HttpOnly | access and refresh token held by the Tauri shell |
| Who sends the request | the browser, same-origin | the shell; the webview passes method, path under the API base, headers and body, and receives the streamed response |
| Unsafe methods | header `X-CSRF-Token` | none (Bearer) |

### Sign-in on the web

- On load Studio calls `GET /api/session`. A 200 answers `{user: {id, name,
  email}, org: {id}, permissions, csrfToken, expiresAt}`. A 401 with code
  `session_required` means anonymous. Any other answer (the dev server, which
  answers every path with 200 and the page itself; a self-hosted static copy)
  means Cloud is not available on this origin and every Cloud control is hidden:
  a 200 counts only when it is JSON of the session's shape.
- "Sign in" is a full-page navigation to `GET /api/session/login?returnTo=<path>`.
  "Switch organization" is the same navigation; the identity provider's
  organization picker decides. Studio restores its open tabs after the return,
  as it does after a reload.
- "Sign out" is `POST /api/session/logout`, then a navigation to the `location`
  it answers.
- A Cloud call answering 401 `session_required` at any time puts Studio back in
  the anonymous state without losing the working copy.

### Sign-in on the desktop

- The shell binds an ephemeral port on `127.0.0.1`, opens the system browser at
  the identity provider's `/oauth2/authorize` (build setting
  `VITE_TELO_ACCOUNTS_URL`, default `https://accounts.telo.run`) as public
  client `telo-studio-desktop` with PKCE S256, `state`, `resource` = the API
  base, redirect `http://127.0.0.1:<port>/callback` and scopes `openid profile
  email offline_access cloud:access cloud:workspaces.admin`. It accepts one
  callback with the matching `state` within 5 minutes, closes the listener and
  redeems the code itself. The user sees the identity provider's consent page on
  every authorization.
- The refresh token is stored in the OS credential store (service
  `com.telo.studio`, account = the identity provider's URL). Without a
  credential store it lives in shell memory until Studio quits; it is never
  written to a file or to webview storage.
- The shell refreshes under a cross-process lock and re-reads the store after
  taking it, so two Studio windows never present a rotated token. `invalid_grant`
  signs the user out; an unreachable identity provider keeps the grant.
- The shell exposes the signed-in user to the webview from `GET /api/v1/principal`
  (`{user: {id}, org: {id}, permissions, expiresAt}`) and `/oauth2/userinfo`
  (name, email).
- "Switch organization" is a new authorization; the previous grant is revoked
  with `POST /oauth2/revoke`. "Sign out" revokes the grant and deletes the stored
  token; the system browser's own session is left alone.

### Opening a workspace

- A signed-in user sees "Open from Telo Cloud": the workspaces of
  `GET /api/v1/workspaces`, each `{id, name, slug, effectiveRole}`.
- Opening one reads `GET /api/v1/workspaces/{ws}/repository` (`{id, kind,
  defaultBranch, status, limits: {maxFileBytes, maxSnapshotFiles,
  maxSnapshotBytes, maxCommitChanges, maxCommitBytes}}`), resolves the default
  branch with `GET …/repository/head?branch=` (`{branch, commit, checkedAt}`),
  and downloads `GET …/repository/snapshot?commit=<sha>`, a tar of the whole tree.
  A `commit` of `null` is an empty repository and opens an empty working copy.
- The snapshot seeds a **working copy**: the working tree plus an untouched copy
  of the base snapshot and its commit. On the web it lives in the browser's
  Origin Private File System, on the desktop in a folder under the app's data
  directory (`cloud/<workspace id>`). It holds bytes, so binary files survive
  untouched; Studio edits text files only and shows the rest as it shows binary
  files today.
- Neither store can hold an executable bit or a symbolic link on every platform,
  so both are kept in the base record beside the tree (`base.json`: the commit,
  the branch, and each path's mode, link target and SHA-256). A changed file is
  committed with the mode its base records, a new one as `file`. A symbolic link
  is not materialized in the working tree: it stays in the repository untouched
  unless a file is written at its path.
- What changed is decided on bytes, below the storage interface the rest of
  Studio uses, which reads every file as text.
- The working copy is exposed to the rest of Studio as one more workspace
  storage backend with root `/cloud/<workspace id>` on both builds: one backend
  over a byte store with two implementations, so no path of the device's file
  system reaches the editor. The explorer, autosave, undo history, runs and the
  authoring agent work on it unchanged: they read and write the working copy,
  and nothing they do reaches Cloud.
- There is one working copy per workspace on a device, bound to one branch.
  Reopening the workspace reuses it. `GET …/repository/branches` lists branches;
  switching requires committing or discarding local changes first.
- With `effectiveRole` `viewer` the workspace is read-only: editing, the agent
  and commit are disabled, running still works.
- The index of working copies is `localStorage` key
  `telo-studio:cloud:working-copies:v1` (user id, org id, workspace id, branch,
  base commit; nothing secret).

### Committing

- Studio shows the changed paths: every difference between the working tree and
  the base snapshot, compared by bytes, outside `.git`. Studio does not evaluate
  `.gitignore`; only Studio and the agent write the working copy.
- "Commit" asks for a message and sends `POST …/repository/commits` with an
  `Idempotency-Key` and `{branch, baseCommit, message, changes}`, each change
  `{op: "put", path, mode: "file" | "executable", encoding: "utf8" | "base64",
  content}` or `{op: "delete", path}`. Cloud sets the author from the signed-in
  user. A 201 answers `{commit, parent, branch, message, author, committedAt}`;
  the base snapshot becomes the committed tree.
- A retry after a network failure, `502 repository_unreachable` or
  `503 overloaded` reuses the same `Idempotency-Key`, so it yields one commit.
- Studio reads `…/repository/head` with `If-None-Match` when the window gains
  focus, every 30 seconds and before every commit. When the branch moved and the
  working copy is clean, Studio updates it to the new head once no run sync or
  agent turn is in progress. When it has local changes, Studio says the branch
  has new commits and offers "Update".
- "Update", and a commit answered `409 branch_moved` (`{branch, baseCommit,
  headCommit}`), run the same merge: download the snapshot at the head and
  compare base, local and head per path. A path changed on one side takes that
  side. A path changed differently on both sides, deletions included, is a
  conflict the user settles per file with "Keep mine" or "Take theirs". Editing
  is paused meanwhile. Afterwards the head is the new base and nothing has been
  committed; the user commits again.
- Other refusals, each with its own message: `409 push_rejected` (the host
  protects the branch; Studio offers to create a branch from the base commit
  with `POST …/repository/branches` `{name, fromCommit}` and commit there),
  `409 repository_credentials_invalid` (a workspace admin must reconnect the
  repository in the console), `413 commit_too_large`, `422 invalid_change`
  (`{path}`), `422 repository_too_large`, `422 repository_quota_exceeded`.
  Studio checks `limits` before sending and names the offending file.

### Publishing

- Each Application and Library in a Cloud workspace has "Publish", for
  `deployer` and `admin`, enabled when the module's directory has no uncommitted
  changes.
- It sends `POST /api/v1/workspaces/{ws}/publications` with an `Idempotency-Key`
  and `{modulePath, commit}`: the directory of the module's `telo.yaml` relative
  to the repository root, and the working copy's base commit. Studio then reads
  `GET …/publications/{pub}` every 2 seconds until `status` is `published` or
  `failed`.
- On `published` Studio shows `ref`
  (`registry.telo.cloud/org_…/wks_…/<module path>`), `version`, `digest` and
  `integrity`, each copyable, and says so when `identical` is true (this content
  was already published). Publishing creates no Cloud app and starts no
  deployment.
- On `failed` Studio renders `error.code`: `version_content_mismatch` (offers to
  open `metadata.version`), `sibling_not_published` (lists `details.refs`; the
  user publishes those first), `import_unpinned`, `import_pin_mismatch`,
  `import_unreachable`, `manifest_invalid` (shows the diagnostics),
  `version_missing`, `module_not_found`, `module_path_invalid`,
  `commit_not_found`, `artifact_too_large`, `repository_unreachable`,
  `repository_credentials_invalid`, `registry_unavailable`, `publish_timeout`,
  `publish_failed`.
- `GET …/modules` and `GET …/modules/{module}/versions` show what is published
  and each module's `visibility`. An `admin` changes it with
  `PATCH …/modules/{module}` `{visibility: "private" | "public"}` and `If-Match`;
  switching to `public` asks for confirmation that anyone can then pull every
  version. A new module is private.

### Leaving

Sign-out removes the Cloud working copies from the device, after a confirmation
that lists the workspaces with uncommitted changes. When a session turns out to
belong to a different user than the stored working copies, Studio asks before it
removes them and otherwise signs out again.

## Decisions

- **Tokens never reach JavaScript.** Studio runs downloaded language engines and
  renders agent and module content; a Cloud token can deploy to customer
  clusters. Rejected: a public OAuth client in the browser, which also needs CORS
  on two services and a silent re-authorization on every reload.
- **The web build is served by Telo Cloud.** `studio.telo.run` moves from GitHub
  Pages behind Cloud's ingress so `/api` is same-origin and the session cookie is
  first-party; a cookie on `console.telo.cloud` would be third-party and blocked.
- **Loopback redirect on the desktop.** It binds the approval to the app instance
  that asked. Rejected: the device flow (nothing ties the approving browser to the
  app) and a custom URL scheme (any installed app can claim it).
- **No content-security policy stands in for the token rule on the desktop.**
  Runners are user-configured hosts, so the webview's network access cannot be an
  allowlist; the guarantee is that the webview holds nothing worth sending.
- **A local working copy, committed explicitly.** Studio autosaves every edit and
  a commit per autosave is unusable history; this is git's own model and Cloud
  stores no half-edited files. The storage interface keeps no version token:
  versions belong to the working copy, not to a file.
- **Whole-snapshot reads.** Studio reads every file on open, on each run and on
  each agent turn, so one tar per commit replaces thousands of calls.
- **Per-file conflict choice, no in-file merge.** Studio has no diff or merge
  view; the server never merges and never forces a push.
- **Workspaces and repository connections are managed in the console.** Studio's
  clients carry only the scopes Studio's features need.

## Outside Studio

- **Telo Cloud** provides every route, client and error code named above, the
  hosted git repository per workspace (or a connected GitHub, GitLab or other
  HTTPS git server), the registry at `registry.telo.cloud` and the publisher.
  Limits it enforces: 5 MiB per file, 10,000 files and 100 MiB per snapshot,
  500 changes and 20 MiB per commit.
- **Hosting.** Release CI publishes the web build as the container image
  `ghcr.io/telorun/studio-web`, serving the static files with the single-page
  fallback, HSTS and `frame-ancestors 'none'`. The GitHub Pages workflow is
  removed once `studio.telo.run` points at Cloud. The move ships first, with no
  behaviour change.
- **CLI.** `telo publish` gains structured JSON output: a stable failure code per
  module and, on success, the pushed version, digest and integrity. Cloud's
  publisher runs it without building controllers; that path must execute no code
  from the published workspace.

## Verify

- Anonymous use on both builds is unchanged, including on an origin with no
  `/api`.
- Devtools on either build show no access or refresh token in memory, storage or
  shell messages.
- A workspace opened on two devices: a commit on one appears on the other within
  30 seconds when it is clean, and as a conflict choice when both changed the
  same file.
- A binary file and an executable script survive open, an unrelated commit and
  reopen byte for byte and with the same mode.
- A commit retried after a dropped connection produces one commit.
- A viewer cannot edit, commit or publish; a deployer cannot change visibility.
- Publishing a commit twice shows the same version the second time with
  `identical`; changing the manifest without changing `metadata.version` fails
  `version_content_mismatch`.
- Two desktop windows left open for an hour stay signed in.

## Housekeeping

Update the Studio page of the docs and Studio's `CLAUDE.md` (a new storage
backend, the Cloud transport and its token rule), add the working-copy index to
the storage-key list, and add a changeset.
