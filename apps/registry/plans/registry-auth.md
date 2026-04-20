# Registry Publish Authentication

## Goal

Gate the Telo module registry's publish endpoint (`PUT /{namespace}/{name}/{version}`) behind bearer-token authentication while keeping every read endpoint anonymous. The CLI sends a token it reads from `TELO_REGISTRY_TOKEN`; the registry verifies it in the first step of the existing `Run.Sequence` publish handler. Failed verification throws a structured `InvokeError("UNAUTHORIZED")` that the route's `catches:` list maps to HTTP 401.

The data model is the "full" shape from day one (`users`, `namespaces`, `tokens`) even though v1 seeds exactly one user (`root`) and one namespace (`std`). This avoids a future migration when additional users, tokens, or namespaces need to exist.

## Non-goals

- **No user registration / self-service token UI.** v1 provisions exactly one user and one token through the registry manifest at boot. Any additional users/tokens require a manifest edit and redeploy.
- **No editor integration.** [apps/telo-editor/](apps/telo-editor/) does not publish today; no token storage, no login flow, no credential UI changes.
- **No credentials dotfile.** Env var only.
- **No per-route middleware.** The auth check lives inside the publish handler's `Run.Sequence` — no pre-handler/interceptor concept added to [modules/http-server/](modules/http-server/).
- **No token scopes beyond namespace ownership.** Ownership of the namespace is the sole authorization axis.
- **No rate limiting, audit log, or token revocation UI.** Revocation happens by changing `TELO_PUBLISH_TOKEN` and redeploying (the seed step deletes the old row by label before inserting the new one). `last_used_at` is updated on successful verification but we don't build dashboards on it.
- **No read-path auth.** Every GET stays anonymous.

## Principles

1. **Declarative over imperative.** Tokens are upserted at boot by a `Sql.Exec` target that reads a plaintext value from env and hashes it inline via a CEL expression. Rotation = change `TELO_PUBLISH_TOKEN` and restart.
2. **Auth is a sequence step, not a framework layer.** Adding the auth check as the first step of the existing `Run.Sequence` keeps the whole publish flow visible in one YAML block.
3. **`sha256` in CEL, handlers passed via constructor.** `StaticAnalyzer` and `Loader` accept an optional `celHandlers: { sha256: (s: string) => string }` in their constructors. The kernel passes a `node:crypto`-backed impl; the browser (VS Code extension, Docusaurus) constructs with no arguments and gets throwing stubs. No mutable global state, dependency visible at the call site.
4. **Full schema from the start; narrow provisioning surface.** The migrations create `users`, `namespaces`, `tokens` with foreign keys as if we had multiple of each. The DB is ready for more without future migrations.
5. **Structured failure via `InvokeError`.** `VerifyToken` throws `InvokeError("UNAUTHORIZED", ...)` on every failure mode. The route's `catches:` maps it to 401. No ad-hoc `{ authorized: false }` discriminator — the error channel is the contract, per the invocable-errors plan ([sdk/nodejs/plans/invocable-errors.md](../../../sdk/nodejs/plans/invocable-errors.md)).

## Architectural decisions

- **No new kind.** Token verification is expressed inline in the publish handler's `Run.Sequence` using `if/throw` steps. `Run.Sequence` gains a first-class `throw` step variant (`throw: { code, message?, data? }`) that throws `InvokeError` directly — replacing the existing `Run.Throw` invocable.
- **CEL stdlib: `sha256(string): string`.** `StaticAnalyzer` and `Loader` accept `celHandlers?: { sha256: (s: string) => string }` in their constructors; each builds its `Environment` from the provided handlers, defaulting to throwing stubs. `precompile.ts` stops importing the module-level singleton and instead receives the `Environment` as a parameter. The module-level `celEnvironment` export is removed. Browser callers (`new StaticAnalyzer()`) get stubs and are unaffected.
- **Hash algorithm: SHA-256, hex-encoded.** Deterministic, no per-token salt. A salt buys nothing here because tokens are high-entropy random strings (not user-chosen passwords) and the threat model is DB exfiltration → rainbow-table lookup, which doesn't apply to 32+ bytes of entropy.
- **Token format: opaque 32-byte base64url string.** ~43 chars. Produced by the operator (e.g. `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`). Not JWT. Not self-describing. The server is always authoritative.
- **Header format: `Authorization: Bearer <token>`.** Any other header (including the absent case) maps to unauthorized.
- **Ownership is per-namespace, not per-(namespace, name).** A token for `std` can publish any module under `std/*`.

## Data model

Four new migrations in [apps/registry/telo.yaml](apps/registry/telo.yaml), after the existing `20260331143022_CreateModules`.

### `20260419100000_CreateUsers`

```sql
CREATE TABLE users (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username   TEXT        UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `20260419100100_CreateNamespaces`

```sql
CREATE TABLE namespaces (
  name       TEXT        PRIMARY KEY,
  owner_id   UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`ON DELETE RESTRICT` — orphaning a namespace is explicit admin work, not a side-effect of deleting a user.

### `20260419100200_CreateTokens`

```sql
CREATE TABLE tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT        UNIQUE NOT NULL,
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ
);
```

`ON DELETE CASCADE` for `user_id`: removing a user kills their tokens. `expires_at` is nullable (= never expires). The seed step does not populate it in v1. The verification query checks it from day one (`AND (t.expires_at IS NULL OR t.expires_at > NOW())`), so expiry enforcement is free when the field is eventually populated.

### `20260419100300_SeedRootUserAndStdNamespace`

```sql
INSERT INTO users (username) VALUES ('root') ON CONFLICT (username) DO NOTHING;
INSERT INTO namespaces (name, owner_id)
  SELECT 'std', id FROM users WHERE username = 'root'
  ON CONFLICT (name) DO NOTHING;
```

## `Run.Sequence` — `throw` step

Add a `throw` step variant to [modules/run/telo.yaml](../../../modules/run/telo.yaml) and [modules/run/nodejs/src/sequence.ts](../../../modules/run/nodejs/src/sequence.ts):

```yaml
- title: throw
  description: Throws an InvokeError unconditionally.
  properties:
    throw:
      type: object
      properties:
        code: { type: string }
        message: { type: string }
        data: {}
      required: [code]
  required: [throw]
```

Runtime: `executeThrowStep` reads `code`/`message`/`data` from the expanded step and throws `InvokeError`. Works inside catch blocks too via `code: "${{ error.code }}"`.

## Registry manifest changes

Edits to [apps/registry/telo.yaml](apps/registry/telo.yaml).

### `Config.Env` — add publish-token secret

Under `secrets:`:

```yaml
publishToken:
  env: TELO_PUBLISH_TOKEN
  type: string
```

### Migrations

Add the four migrations from **Data model** above after `20260331143022_CreateModules`.

### Boot-time token seed

```yaml
kind: Sql.Exec
metadata:
  name: SeedRootPublishToken
connection:
  kind: Sql.Connection
  name: Db
sql: |
  DELETE FROM tokens
  WHERE user_id = (SELECT id FROM users WHERE username = 'root')
    AND label = 'root-publish-token';
  INSERT INTO tokens (user_id, token_hash, label)
  SELECT id, $1, 'root-publish-token' FROM users WHERE username = 'root';
bindings:
  - "${{ sha256(resources.AppConfig.publishToken) }}"
```

`sha256()` runs once at boot when the seed target invokes, against the already-resolved `AppConfig.publishToken`. The DELETE + INSERT under the same label means rotation leaves no stale rows.

`Telo.Application.targets`:

```yaml
targets:
  - Migrations
  - SeedRootPublishToken
  - RegistryServer
```

### PUT handler — verify then publish

```yaml
handler:
  kind: Run.Sequence
  steps:
    - name: checkHeader
      if: "${{ !request.headers.authorization.startsWith('Bearer ') }}"
      then:
        - name: rejectHeader
          throw: { code: UNAUTHORIZED, message: Missing or malformed Authorization header }

    - name: verifyToken
      invoke:
        kind: Sql.Query
        connection: { kind: Sql.Connection, name: Db }
      inputs:
        sql: >-
          SELECT u.id AS user_id, u.username
          FROM tokens t
          JOIN users u ON u.id = t.user_id
          JOIN namespaces n ON n.owner_id = u.id
          WHERE t.token_hash = $1 AND n.name = $2
            AND (t.expires_at IS NULL OR t.expires_at > NOW())
          LIMIT 1
        bindings:
          - "${{ sha256(request.headers.authorization.slice(7)) }}"
          - "${{ request.params.namespace }}"

    - name: checkToken
      if: "${{ steps.verifyToken.result.rows.size() == 0 }}"
      then:
        - name: rejectToken
          throw: { code: UNAUTHORIZED, message: Invalid token or namespace not owned }

    - name: upload
      try:
        - name: doUpload
          invoke:
            kind: S3.Put
            bucketRef: { name: ModuleStore }
          inputs:
            key: "${{ inputs.fileKey }}"
            body: "${{ inputs.body }}"
            contentType: "text/yaml"
      catch:
        - name: rethrow
          throw:
            code: UPLOAD_FAILED
            message: "${{ error.message }}"

    - name: record
      try:
        - name: doRecord
          invoke:
            kind: Sql.Exec
            connection: { kind: Sql.Connection, name: Db }
          inputs:
            sql: >-
              INSERT INTO modules (namespace, name, version, file_key)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (namespace, name, version) DO UPDATE SET file_key = EXCLUDED.file_key
            bindings:
              - "${{ inputs.namespace }}"
              - "${{ inputs.name }}"
              - "${{ inputs.version }}"
              - "${{ inputs.fileKey }}"
      catch:
        - name: rethrow
          throw:
            code: RECORD_FAILED
            message: "${{ error.message }}"
  outputs:
    published: "${{ inputs.published }}"
```

The outer `inputs:` block on the route is unchanged. No new kinds or controllers — only existing `Sql.Query`, `S3.Put`, `Sql.Exec`, and the new `throw` step. Operational failures from S3 and SQL are wrapped as `InvokeError` with domain codes (`UPLOAD_FAILED`, `RECORD_FAILED`) so every error exits through the route's `catches:` list — there is no "plain error" fall-through path.

### Route outcomes

```yaml
returns:
  - status: 201
    body:
      published: "${{ result.published }}"

catches:
  - when: "${{ error.code == 'UNAUTHORIZED' }}"
    status: 401
    body:
      error: "${{ error.message }}"
  - when: "${{ error.code == 'UPLOAD_FAILED' || error.code == 'RECORD_FAILED' }}"
    status: 500
    body:
      error: "${{ error.message }}"
```

## CLI changes

Edits to [cli/nodejs/src/commands/publish.ts:172-223](cli/nodejs/src/commands/publish.ts#L172-L223) — the `pushToTeloRegistry` function.

```ts
const token = process.env.TELO_REGISTRY_TOKEN;
const headers: Record<string, string> = { "content-type": "text/yaml" };
if (token) headers.authorization = `Bearer ${token}`;

res = await fetch(url, { method: "PUT", headers, body: content });
```

On 401, the existing `!res.ok` branch surfaces the error body — no further change needed.

Update CLI docs with `TELO_REGISTRY_TOKEN` env var meaning and example usage.

## Documentation

Update `apps/registry/README.md` — add an "Authentication" section explaining that PUT requires a bearer token and how operators provision one via `TELO_PUBLISH_TOKEN`.

## Phases

### Phase 0 — CEL stdlib: `sha256`

- Add `celHandlers?: { sha256: (s: string) => string }` to `StaticAnalyzer` and `Loader` constructors; each builds its `Environment` internally from the provided handlers (stubs if omitted).
- Refactor `precompile.ts` to accept the `Environment` as a parameter rather than importing the module-level singleton. Remove the `celEnvironment` module export.
- Kernel constructs `new StaticAnalyzer({ celHandlers })` and `new Loader({ registryUrl, celHandlers })` where `celHandlers = { sha256: (s) => createHash("sha256").update(s).digest("hex") }`.
- Unit test: `sha256("hello")` returns correct hex when handlers are passed; throws when constructed without handlers.

### Phase 1 — `Run.Sequence` throw step

- Add `ThrowStep` interface, `isThrowStep` guard, and `executeThrowStep` to [modules/run/nodejs/src/sequence.ts](../../../modules/run/nodejs/src/sequence.ts).
- Add `throw` variant to `$defs/step` oneOf in [modules/run/telo.yaml](../../../modules/run/telo.yaml).
- Remove `Run.Throw` kind from `telo.yaml`, `throw.ts`, and `exports`; migrate existing `invoke: { kind: Run.Throw }` usages in `modules/run/tests/` and `modules/http-server/tests/` to `throw:` steps.
- Unit tests in `modules/run/tests/`.

No dependency on registry or CEL changes. Can ship standalone.

### Phase 2 — Registry integration

**Prerequisite: invocable-errors Phase 2** (`resolve-throws-union.ts`) must be merged before this ships. `Run.Sequence` propagating `UNAUTHORIZED` via `throws: { inherit: true }` is a Phase 2 analyzer feature. Workaround if shipping earlier: declare `throws: { codes: { UNAUTHORIZED: {...} } }` explicitly on the sequence manifest instance.

- Add four migrations.
- Add `SeedRootPublishToken` Sql.Exec target, `TELO_PUBLISH_TOKEN` secret.
- Rewrite the PUT handler with inline `if/throw` auth steps and route outcomes.
- Integration tests (see below).

Requires Phase 0 and Phase 1.

### Phase 3 — CLI publish

- Read `TELO_REGISTRY_TOKEN`, add bearer header.
- Update CLI docs.

## Testing

**Registry integration tests** — new YAML in `apps/registry/tests/`. Boot the registry, use `HttpClient.Request` to:

- PUT without a token → 401.
- PUT with a wrong token → 401.
- PUT with the right token to the wrong namespace → 401.
- PUT with the right token to the owned namespace → 201.
- GET after a successful PUT works anonymously.
- Boot twice with the same token → one row in `tokens` (seed is idempotent).
- Boot with a rotated token → old token rejected, new token accepted.

## Open questions

1. **Error body shape.** Current plan renders `{ error: "<error.message>" }`. If the code is also wanted (`{ error: { code, message } }`), that's a one-line body change — `error.code` and `error.message` are both in scope in `catches:` CEL.

## Out-of-scope follow-ups

- **`telo login` command** + `~/.config/telo/credentials.json` — per-registry token store.
- **Editor publish UI** — reads from the credentials file above.
- **`Namespace` resource kind** — declarative namespace creation (replaces the seed migration).
- **Token scopes** — `publish`, `yank`, `admin`.
- **Token expiration** — populate `expires_at` in the seed step.
- **Audit log** — `publish_events (token_id, namespace, name, version, at)`.
- **Rate limiting** — per-token publish limits.
- **Private modules / read-path auth.**
