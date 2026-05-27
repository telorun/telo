# Registry unpublish

Add a `DELETE /{namespace}/{name}/{version}` route to the Telo module registry
that hard-deletes a published version: removes the row from `modules` and the
object from S3. Authenticated by the same `TELO_PUBLISH_TOKEN`-based token
flow as publish.

## Scope

- New resource kind `S3.Delete` in `modules/s3` (the registry needs it; no
  S3 delete primitive exists yet, and `JS.Script` is a last resort per
  CLAUDE.md).
- New `Run.Sequence` `UnpublishHandler` in `apps/registry/telo.yaml`,
  factored alongside `PublishHandler`.
- New `DELETE /{namespace}/{name}/{version}` route on `PublicApi`.
- Test coverage in `apps/registry/tests/` and `apps/registry/test-suite-e2e.yaml`.
- Docs touched: `modules/s3/docs/`, `apps/registry/README.md`.
- One changeset per affected published package (`@telorun/s3`, plus the
  registry app if it ships as a package — verify).

## Step 1 — `S3.Delete` kind

New `Telo.Definition` in `modules/s3/telo.yaml`, capability `Telo.Invocable`,
controller `pkg:npm/@telorun/s3@<next>?local_path=./nodejs#s3-delete`.

Schema mirrors `S3.Get`:

- `bucketRef.name: string` (required, schema-level).
- `inputType.key: string` (required).
- `outputType`: empty object — delete has no payload to return.

**Idempotency**: SDK v3 `DeleteObjectCommand` returns success even if the key
doesn't exist. Mirror that — no `ERR_NOT_FOUND`. Only throw on transport /
auth failures, mapped to `ERR_INVALID_RESPONSE` for symmetry with `S3.Get`.
This matches S3's own semantics and keeps unpublish flows simpler (re-running
a partial unpublish doesn't spuriously error).

Controller in `modules/s3/nodejs/src/s3-delete-controller.ts`. Wire into
`src/index.ts`. Add unit test in `modules/s3/tests/` (PUT then DELETE then
GET-returns-ERR_NOT_FOUND).

## Step 2 — `UnpublishHandler` in registry

New top-level `Run.Sequence` in `apps/registry/telo.yaml`, named
`UnpublishHandler`. Mirrors `PublishHandler`'s structure (extracted as a
top-level sequence so CEL context in `catch:` blocks works).

Steps:

1. `checkHeader` — reject missing/malformed `Authorization`.
2. `verifyToken` — same CTE-based query as `PublishHandler` (token + ownership
   on `namespace`, touch `last_used_at`). Identical SQL — copy verbatim, do
   not factor yet (would need a callable sub-sequence with arg passing; not
   worth the indirection for one duplication).
3. `checkToken` — reject if no rows.
4. `lookup` — `SELECT file_key FROM modules WHERE namespace=$1 AND name=$2
   AND version=$3`. Captures the S3 key for step 5.
5. `checkExists` — if `lookup.result.rows.size() == 0`, throw `NOT_FOUND`
   (route maps to 404).
6. `deleteS3` — `S3.Delete` against the captured `file_key`. Wrapped in
   `try/catch` → `DELETE_FAILED` (500). S3 first so a DB row never points
   to a missing object.
7. `deleteRow` — `DELETE FROM modules WHERE namespace=$1 AND name=$2
   AND version=$3`. Wrapped in `try/catch` → `RECORD_FAILED` (500).

Output: `{ unpublished: "<namespace>/<name>@<version>" }`.

**Ordering note**: S3-then-DB. If DB delete fails after S3 delete succeeds,
the row is a tombstone pointing at a missing object — `GET` already returns
404 in that case via the existing S3 `ERR_NOT_FOUND` catch. Reverse ordering
(DB then S3) would leave an orphan S3 object on partial failure, which is
worse (storage leak, no way to find it via the index). Re-running the
unpublish for that version cleans up the row idempotently.

## Step 3 — Route

New entry in the `PublicApi` `routes:` array:

```yaml
- request:
    path: /{namespace}/{name}/{version}
    method: DELETE
    schema:
      params:
        type: object
        properties:
          namespace: { type: string }
          name: { type: string }
          version: { type: string }
        required: ["namespace", "name", "version"]
  handler:
    kind: Run.Sequence
    name: UnpublishHandler
  inputs:
    authorization: "${{ has(request.headers.authorization) ? request.headers.authorization : '' }}"
    namespace: "${{ request.params.namespace }}"
    name: "${{ request.params.name }}"
    version: "${{ request.params.version }}"
  returns:
    - status: 200
      content:
        application/json:
          body:
            unpublished: "${{ result.unpublished }}"
  catches:
    - when: "${{ error.code == 'UNAUTHORIZED' }}"
      status: 401
      ...
    - when: "${{ error.code == 'NOT_FOUND' }}"
      status: 404
      ...
    - when: "${{ error.code == 'DELETE_FAILED' || error.code == 'RECORD_FAILED' }}"
      status: 500
      ...
```

Update the route-list comment at the top of `PublicApi` to document the new
endpoint. Sort alphabetically with the other routes for the namespace/name/version
path so the route table reads cleanly.

## Step 4 — Tests

In `apps/registry/tests/`:

- `unpublish.yaml` — PUT a manifest, DELETE it, GET returns 404 from both
  metadata and `/telo.yaml` paths. Re-DELETE on the now-missing version
  returns 404 (not 200, not 500).
- `unpublish-auth.yaml` — DELETE without `Authorization` → 401. DELETE with a
  token that doesn't own the namespace → 401.
- `unpublish-nonexistent.yaml` — DELETE on a never-published version → 404
  without S3 or DB side effects.

In `apps/registry/test-suite-e2e.yaml`: add an end-to-end PUT → DELETE → GET
flow against a live containerised stack if e2e already covers the publish
flow (verify before adding).

## Step 5 — Docs

- `modules/s3/docs/` — new page for `S3.Delete` (or extend an existing
  CRUD-style overview). Wire into `pages/docusaurus.config.ts` `include` and
  `pages/sidebars.ts`. Add `sidebar_label` frontmatter.
- `apps/registry/README.md` — add the `DELETE` row to the routes table.

## Step 6 — Release plumbing

- `.changeset/` entry for `@telorun/s3` — **minor** bump (new public kind).
- If `apps/registry` ships as a published package, add an entry for it too;
  if it's deploy-only, skip.
- Once landed and deployed, the registry is ready for the cleanup pass that
  mirrors `scripts/npm-unpublish-1x.mjs`: a sibling script that walks the
  registry index and `DELETE`s every `version >= 1.0.0`. **Not in this PR.**
  Land the endpoint first so it's reviewable in isolation; do the cleanup as
  a separate change once the endpoint is deployed.

## Out of scope (explicit)

- Soft delete / tombstones. Decided: hard delete only.
- Per-route auth roles. Decided: same publish token, no admin role split.
- Bulk delete (`DELETE /{namespace}/{name}` removes all versions). Easy
  follow-up if needed; not required for the immediate cleanup which goes
  version-by-version.
- Audit log of unpublishes. The `tokens.last_used_at` touch already records
  which token acted; if a dedicated audit table becomes useful later, add
  it then.
