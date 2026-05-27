# Registry MCP Server

Expose the module registry as an MCP server so that AI agents can discover modules and read their `telo.yaml` source when authoring new applications. Bundled with the prerequisite fix that makes module descriptions actually appear in the registry (see [Fix: descriptions never get persisted](#fix-descriptions-never-get-persisted)).

## Goals

1. **Discovery** — an MCP `tools/list` consumer sees a tool that lists modules.
2. **Decision support** — listed modules include `description` so the model can judge usefulness without a second roundtrip per result.
3. **Source access** — a second tool returns the raw `telo.yaml` for a chosen module so the model can understand its schema and use it.
4. **Onboarding** — a model with zero prior Telo knowledge gets a primer (what Telo is, how manifests are shaped, what kinds exist, how to compose them) automatically on connect, so it can use the tools effectively.

## Surface

Two MCP tools, both backed by handlers that already exist (or compose trivially) in [apps/registry/telo.yaml](../telo.yaml).

### Tool 1: `search_modules`

**Purpose:** "Show me everything in the registry."

**Arguments:** none for now. The registry has a handful of modules today; filter / pagination args land when scale demands them. Keeping the `search_` name so the eventual addition of `q` / `limit` / `offset` is purely additive — no rename, no MCP client breakage.

**Result content (single text block, JSON-encoded):**

```json
{
  "results": [
    { "id": "std/http-server@0.5.0", "namespace": "std", "name": "http-server",
      "version": "0.5.0", "description": "...", "publishedAt": "..." }
  ],
  "count": 47
}
```

**Implementation:** delegate to the existing [SearchModules `Sql.Select`](../telo.yaml#L252-L297) — its `outputType` already exposes `rows` + `rowCount` and each row already includes `description`. The MCP tool's `inputs:` block passes empty `q` / `id` and a high `limit` (e.g. 1000) to retrieve everything; `result:` block JSON-stringifies the rows via a new `json()` CEL handler (see [Kernel: `json()` CEL handler](#kernel-json-cel-handler)) into a single text content block: `text: "${{ json({results: result.rows, count: result.rowCount}) }}"`.

### Tool 2: `get_module_manifest`

**Purpose:** "Give me the actual `telo.yaml` for this module so I can read its kinds, schemas, and examples."

**Arguments:**

| Field       | Type   | Required | Notes                                                                |
| ----------- | ------ | -------- | -------------------------------------------------------------------- |
| `namespace` | string | yes      |                                                                      |
| `name`      | string | yes      |                                                                      |
| `version`   | string | yes      | Explicit version. Models call `search_modules` first to discover it. |

**Result content:** one text block containing the raw YAML.

**Catches:**

- `ERR_NOT_FOUND` → JSON-RPC error with `code: -32004, message: "Module not found"`.

## Telo primer via MCP `instructions`

MCP's `InitializeResult` carries an optional top-level `instructions` string that compatible clients (Claude Desktop, etc.) surface to the LLM as system context. We use it to teach the model what Telo is before it starts calling tools — no extra tool round-trip, no prompt engineering on the client side.

### Upstream change in [modules/mcp-server](../../../modules/mcp-server/)

Both `Mcp.HttpEndpoint` and `Mcp.StdioServer` currently accept only `serverInfo: {name, version}` ([telo.yaml:362-406](../../../modules/mcp-server/telo.yaml#L362-L406) and [411-455](../../../modules/mcp-server/telo.yaml#L411-L455)). Add an optional `instructions: string` sibling field on **both** transports (keeps the schemas symmetric) and forward it to the SDK `Server` constructor's `instructions` option in each controller — http-endpoint at the per-session build site, stdio-server at the single-server build site.

- Schema: one new property on each transport definition.
- Controllers: pass `{ instructions: spec.instructions }` into every `new Server(...)` call.
- Tests: a focused mcp-server test per transport asserting the value is round-tripped on `initialize`.
- Changeset: one entry covering `@telorun/mcp-server`.

### Registry usage

The registry sets `instructions:` on its `Mcp.HttpEndpoint` to a Telo primer covering:

- **What Telo is:** declarative runtime where YAML manifests describe desired state; a kernel resolves resources via a multi-pass init loop and runs them through controllers.
- **Manifest shape:** one `Telo.Application` doc, then `Telo.Import` docs for each module needed, then resource docs (`kind: <Module>.<Kind>`) wired together via `${{ }}` CEL templates.
- **How kinds are discovered:** every module's `telo.yaml` defines its kinds via `Telo.Definition` blocks with JSON Schema for each — read the manifest to learn the surface.
- **Available primitives:** brief mention of common modules (`http-server`, `http-client`, `sql`, `javascript`, `config`, `run`, `assert`) without enumerating every kind.
- **How to use these MCP tools:** call `search_modules` to see what's available, then `get_module_manifest` for any module whose description looks promising; the returned YAML defines the exact `kind:` names and field shapes to use.

Source of the primer string: an inline multi-line string literal in [apps/registry/telo.yaml](../telo.yaml) (`instructions: |` block scalar). The `$include` directive in [yaml-cel-templating/nodejs/src/index.ts:239](../../../yaml-cel-templating/nodejs/src/index.ts#L239) is not implemented today and out of scope for this work; inline keeps the change small and the primer is short enough that YAML escaping isn't a real burden.

## Stream → string conversion

`S3.Get` returns `output` as a stream (`x-telo-stream: true` — [s3/telo.yaml:168-181](../../../modules/s3/telo.yaml#L168-L181)) but the MCP tool needs the YAML as a *string* in `result.content[0].text`. The existing `PlainText.Decoder` ([plain-text-codec/telo.yaml:36-52](../../../modules/plain-text-codec/telo.yaml#L36-L52)) is the natural primitive: it implements `Codec.Decoder` (input: `Stream<Uint8Array>`; output: `{ text: string }`) and drains the whole stream into a UTF-8 string.

The `get_module_manifest` handler is a `Run.Sequence` with two steps and an explicit `outputs:` mapping — `Run.Sequence`'s result comes from `outputs:`, not from the last step ([modules/run/telo.yaml:238-242](../../../modules/run/telo.yaml#L238-L242)):

```yaml
kind: Run.Sequence
metadata: { name: GetModuleManifest }
steps:
  - name: fetch
    invoke: { kind: S3.Get, bucketRef: { name: ModuleStore } }
    inputs:
      key: "${{ inputs.namespace + '/' + inputs.name + '/' + inputs.version + '/telo.yaml' }}"
  - name: decode
    invoke: { kind: PlainText.Decoder }
    inputs:
      input: "${{ steps.fetch.result.output }}"
outputs:
  text: "${{ steps.decode.result.text }}"
```

Accessing `steps.fetch.result.output` is allowed — only member access *past* a stream-marked property is forbidden by the analyzer. Add a `Telo.Import` for `plain-text-codec` to the registry manifest.

## Kernel: `json()` CEL handler

CEL has no native JSON-stringify and only `sha256` is registered in the kernel today ([kernel/nodejs/src/kernel.ts:73](../../../kernel/nodejs/src/kernel.ts#L73)). The `search_modules` tool needs to embed structured rows in a single MCP text content block, which requires stringification.

Add a `json(value)` handler alongside `sha256`:

- Input: any CEL value.
- Output: a `string` containing the JSON encoding (no indentation, sorted keys not required).
- Implementation: `JSON.stringify(value)`. Reject `undefined` / functions; pass everything else through.

This is a tiny, cross-cutting kernel addition — useful far beyond this plan (any CEL site that wants to log, hash, or transmit structured data). Lands in the same PR as the rest of the work.

## Known type-checking blind spots

The plan reuses two patterns the analyzer is lenient about; both already have precedent in production code so they're not blockers, but worth flagging so future contributors don't assume the analyzer would have caught a mistake here:

- **Run.Sequence used where an Invocable is expected.** `Mcp.Tools.entries[].handler` carries `x-telo-ref: "telo#Invocable"` ([modules/mcp-server/telo.yaml:55](../../../modules/mcp-server/telo.yaml#L55)) but `Run.Sequence` declares `capability: Telo.Runnable` ([modules/run/telo.yaml:14](../../../modules/run/telo.yaml#L14)). It works because the runtime dispatcher uses `invokeResolved` ([kernel/nodejs/src/evaluation-context.ts:469-482](../../../kernel/nodejs/src/evaluation-context.ts#L469-L482)) which only checks for an `invoke()` method — Run.Sequence's controller exposes one ([modules/run/nodejs/src/sequence.ts:165](../../../modules/run/nodejs/src/sequence.ts#L165)). Same trick is already in use for `PublishHandler` as an HTTP route handler.
- **`Mcp.Tools.entries[].result` CEL is opaque-typed.** That field uses `x-telo-context-ref-from: "handler/outputType"` ([modules/mcp-server/telo.yaml:116](../../../modules/mcp-server/telo.yaml#L116)) — but `Run.Sequence` has no kind-level `outputType` (only per-instance `outputs:`), so the analyzer's CEL type-check on the result block degrades to opaque. `${{ result.text }}` won't be statically validated, but it's covered by the runtime contract (the sequence's `outputs:` declares `text`).

## Fix: descriptions never get persisted

The `description` column is NULL on every row in production today (see `https://registry.telo.run/search`). The `PublishHandler` `INSERT` ([apps/registry/telo.yaml:376-385](../telo.yaml#L376-L385)) lists only `(namespace, name, version, file_key)` and the `ON CONFLICT DO UPDATE` only refreshes `file_key`. Even when the published YAML has a description, it's discarded.

This blocks goal 2 (decision support): the LLM needs the description to judge module relevance. After the fix, descriptions populate naturally as modules get republished — no manual backfill needed.

### New module: `modules/yaml/`

To extract `metadata.description` from the published YAML body server-side, we need a YAML parsing primitive. None exists today — the format-codec modules (`plain-text-codec`, `ndjson-codec`, `sse-codec`, `octet-codec`) are all stream-oriented (`Codec.Encoder` / `Codec.Decoder` carry `Stream<Uint8Array>`), and YAML parsing is fundamentally batch (you need the full document to parse). It doesn't belong under `Codec.*`, hence a standalone `modules/yaml/` module rather than `yaml-codec`.

- **Kind:** `Yaml.Parse` — `capability: Telo.Invocable`.
- **Input:** `{ text: string }`.
- **Output:** `{ docs: object[] }` — always multi-doc-aware (`yaml.loadAll`). Single-doc callers use `result.docs[0]`. Telo manifests are always multi-doc, so this matches the dominant use case.
- **Throws:** `ERR_PARSE_FAILED` on malformed YAML (with line/column from the parser when available).
- **Implementation:** thin wrapper over `yaml`'s (eemeli/yaml) `parseAllDocuments` — same parser the kernel/analyzer already use, so manifests are seen consistently across boot-time loading and runtime parsing.
- **Future:** `Yaml.Stringify` (object → string) lands when the first consumer needs it.

This is a new generic primitive — flagging the architectural addition per CLAUDE.md, but per your call, going ahead with `modules/yaml/`.

### Registry: extend `PublishHandler`

Per CLAUDE.md, every module file MUST start with exactly one `Telo.Library` or `Telo.Application` doc, so `docs[0]` is always the root doc — no array search, no filter. Insert two new steps before the existing `record` step in [PublishHandler](../telo.yaml#L303-L392):

1. **`parseManifest`** — invoke `Yaml.Parse` with the body. Caught failure throws `MANIFEST_PARSE_FAILED`, mapped to a 400 in the route's `catches`.
2. **`validateRootDoc`** — `if` check that throws `INVALID_MANIFEST` (→ 400) when `size(steps.parseManifest.result.docs) == 0` or `!(steps.parseManifest.result.docs[0].kind in ['Telo.Library', 'Telo.Application'])`. Pulls double-duty: also catches "publisher sent garbage YAML" up front. Both kinds are accepted — the registry stays policy-neutral about whether a published module is importable; that's enforced by the loader at consumption time.

Then expand the `record` step's INSERT to include `description`, reading it off `docs[0]` with `has()` guards on each intermediate (cel-js's `has()` permits a missing leaf but throws on a missing intermediate — so we guard `metadata` separately from `metadata.description`):

```sql
INSERT INTO modules (namespace, name, version, file_key, description)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (namespace, name, version) DO UPDATE
  SET file_key = EXCLUDED.file_key,
      description = EXCLUDED.description
```

Bindings:

```cel
${{
  has(steps.parseManifest.result.docs[0].metadata) &&
  has(steps.parseManifest.result.docs[0].metadata.description)
    ? steps.parseManifest.result.docs[0].metadata.description
    : ''
}}
```

`ON CONFLICT` updates the description on republish so future releases naturally pick up changes.

## Implementation outline

Four packages get touched: `kernel/nodejs` (`json()` CEL handler), `modules/mcp-server` (upstream `instructions` support on both transports), new `modules/yaml/` (parse primitive), and `apps/registry` (publish-fix + MCP wiring).

### Kernel: `kernel/nodejs`

1. Add `json: (v: unknown) => JSON.stringify(v)` to `celHandlers` in [kernel/nodejs/src/kernel.ts:73](../../../kernel/nodejs/src/kernel.ts#L73), next to `sha256`.
2. Add a focused test in the kernel's CEL handler suite asserting `${{ json({a:1, b:[1,2]}) }}` returns the expected string.
3. Changeset entry for `@telorun/kernel` (minor: additive).

### Upstream: `modules/mcp-server`

1. Add optional `instructions: { type: string }` to **both** the `HttpEndpoint` and `StdioServer` schemas in [modules/mcp-server/telo.yaml](../../../modules/mcp-server/telo.yaml).
2. Forward the value to the MCP SDK `Server` constructor's `instructions` option in both controllers — the http-endpoint per-session build site and the stdio-server single-server build site.
3. Add focused tests (one per transport) asserting `initialize` returns the configured string.
4. Changeset entry for `@telorun/mcp-server` (minor: additive).
5. Docs: mention `instructions` in [modules/mcp-server/README.md](../../../modules/mcp-server/README.md) and both `docs/http-endpoint.md` and `docs/stdio-server.md`.

### New: `modules/yaml/`

1. Scaffold the module: `telo.yaml` (`Telo.Library`, exports `Parse`), `nodejs/` workspace, `docs/`, `tests/`, `package.json` (`@telorun/yaml`).
2. Declare `Yaml.Parse` (`Telo.Invocable`): input `{ text: string }`, output `{ docs: object[] }`, throws `ERR_PARSE_FAILED`.
3. Controller: thin wrapper over `yaml`'s (eemeli/yaml) `parseAllDocuments`.
4. Tests: single-doc, multi-doc, empty input, malformed input.
5. README + per-kind doc.
6. Changeset entry for `@telorun/yaml` (initial release).

### Registry: `apps/registry`

All edits in [apps/registry/telo.yaml](../telo.yaml) unless noted. No new TS.

1. Add `Telo.Import`s for `Mcp` (`../../modules/mcp-server`), `PlainText` (`../../modules/plain-text-codec`), and `Yaml` (`../../modules/yaml`) alongside the existing imports (~line 43).
2. Extend `PublishHandler` with `parseManifest` + `validateRootDoc` steps and update the `record` step's INSERT to include `description` with `ON CONFLICT … SET description = EXCLUDED.description` (see [Fix: descriptions never get persisted](#fix-descriptions-never-get-persisted)).
3. Add `MANIFEST_PARSE_FAILED` → 400 and `INVALID_MANIFEST` → 400 entries to the PUT route's `catches`.
4. Declare a `Run.Sequence` named `GetModuleManifest` with the `S3.Get` → `PlainText.Decoder` chain and explicit `outputs: { text: "${{ steps.decode.result.text }}" }` (see [Stream → string conversion](#stream--string-conversion)).
5. Declare `Mcp.Tools` bundle named `RegistryTools` with the two entries above.
   - `search_modules` handler refers to `SearchModules` `Sql.Select`. `result:` CEL: `text: "${{ json({results: result.rows, count: result.rowCount}) }}"`.
   - `get_module_manifest` handler refers to `GetModuleManifest`. `result:` CEL: `text: "${{ result.text }}"`.
6. Declare `Mcp.HttpEndpoint` (`McpHttp`) referencing `RegistryTools`, with the Telo primer as an inline `instructions: |` block scalar (no separate file).
7. Add `{ path: /mcp, type: Mcp.HttpEndpoint.McpHttp }` to the existing `RegistryServer.mounts` (currently [line 229-233](../telo.yaml#L229-L233)). Mount type follows `<ImportAlias>.<KindName>.<ResourceName>` (precedent: `Http.Api.PublicApi`).
8. **Docs:** extend [apps/registry/README.md](../README.md) with an "MCP" section and a note that publish now reads `metadata.description` from the body's root doc.
9. **Tests:** add `apps/registry/tests/publish-description.yaml` (publish a module with a description, GET it back, assert `description` is set), `apps/registry/tests/mcp-search.yaml`, `apps/registry/tests/mcp-get-manifest.yaml`, and `apps/registry/tests/mcp-instructions.yaml`, modeled on [http-tool-call.yaml](../../../modules/mcp-server/tests/http-tool-call.yaml).
10. **Changeset:** one entry under `.changeset/` covering `apps/registry`.

## Out of scope

- **Auth on MCP tools.** Read tools are anonymous, matching the existing public HTTP read endpoints. A `publish_module` tool would require token auth and is deferred.
- **Resources / Prompts.** `Mcp.Resources` and `Mcp.Prompts` runtime dispatch lands in the mcp-server module's v2; even when available, exposing the registry catalog as MCP *resources* (in addition to tools) is a follow-up.
- **Latest-version resolution.** `get_module_manifest` requires an explicit `version`. A `version`-optional variant that resolves to the most recent published version is deferred — `search_modules` already exposes the latest per `(namespace, name)` via `SearchModules`'s `distinctOn`, so the "search → get" flow works today.
- **Streaming responses.** Tool results are buffered text. Telo-yaml files are small enough that this isn't a concern.
