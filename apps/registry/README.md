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

## MCP

The registry exposes a Model Context Protocol server at `POST /mcp` (Streamable HTTP transport, mounted on the same `Http.Server` as the REST API) so AI agents can discover modules and read their `telo.yaml` source without needing to know the REST surface.

On `initialize`, the server returns an `instructions` primer that teaches the LLM what Telo is and how to use the exposed tools. Compatible MCP clients (Claude Desktop, etc.) surface this to the LLM as system context, so a model with no prior Telo knowledge can compose a manifest from what the tools return.

### Tools

| Tool                  | Args                           | Returns                                                                                                                      |
| --------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `search_modules`      | none                           | JSON object `{ results: [{id, namespace, name, version, description, publishedAt}], count }` as a single text content block. |
| `get_module_manifest` | `namespace`, `name`, `version` | The raw `telo.yaml` for the requested version as a text content block. JSON-RPC `-32004` if the module isn't found.          |

### Description indexing

The publish endpoint reads `metadata.description` from the body's root document (must be `Telo.Library` or `Telo.Application`) using `Yaml.Parse` and stores it in the `description` column. Missing descriptions, missing `metadata` blocks, and non-string descriptions (e.g. a publisher accidentally supplying a YAML mapping) all bind as SQL `NULL` — keeping "no description" distinct from an explicit empty string and matching the column's existing semantics for legacy rows. `ON CONFLICT … SET description = EXCLUDED.description` means republishing a module with an updated description refreshes the indexed value, so the natural release cadence keeps descriptions current — no separate backfill step.
