# Telo Registry

A module registry for the Telo declarative runtime — publish, resolve, and download Kernel modules. Packages are stored as tarballs in Cloudflare R2 and indexed in a Cloudflare D1 SQLite database.

> **Note:** This is conceptual work. The module definitions here sketch out what the registry would look like once the required kernel modules exist. They are not runnable yet — the missing pieces are listed below.

## Authentication

Read endpoints (`GET /search`, `GET /{namespace}/{name}/…`) are **anonymous**. The publish endpoint (`PUT /{namespace}/{name}/{version}`) requires a bearer token.

### Token provisioning

The registry seeds a single root user (`root`) and reserved `std` namespace at boot. Operators provision the publish token via `TELO_PUBLISH_TOKEN`:

```bash
# Generate a high-entropy token (~43 chars, base64url)
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

# Pass it to the registry at startup
TELO_PUBLISH_TOKEN=<token> telo ./apps/registry/telo.yaml
```

At boot, the `SeedRootPublishToken` target deletes any previous row labelled `root-publish-token` and inserts a fresh SHA-256 hash of the new token. Rotation is: change `TELO_PUBLISH_TOKEN` and restart.

### Publishing

Callers (including the Telo CLI) authenticate with an `Authorization: Bearer <token>` header. The CLI reads its token from `TELO_REGISTRY_TOKEN`:

```bash
TELO_REGISTRY_TOKEN=<token> telo publish ./modules/my-module/telo.yaml
```

Failures return JSON:

- `401 Unauthorized` when the header is missing/malformed, the token is invalid, or the token's user does not own the target namespace.
- `500` for upload/database failures, with a structured `{ error: { code, message } }` body.

### Scope

v1 provisions exactly one user (`root`) and one namespace (`std`). Any additional users, namespaces, or tokens require a manifest edit and redeploy. Token scopes are namespace-ownership only — a token for `std` can publish any module under `std/*`.
