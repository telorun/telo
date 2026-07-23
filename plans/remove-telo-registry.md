# Remove the Telo registry (keep read-only resolution, hub as discovery)

## Problem

The Telo module registry exists in three separable forms: the **server app**
(`apps/registry/`, a deployable HTTP service with Postgres + S3, publish/auth,
MCP, search, hosted at `registry.telo.run`), the **publish/release machinery**
that pushes module manifests to it, and the **runtime resolver**
(`RegistryTransport` / `RegistrySource`) that turns a bare `std/x@version` import
into a plain `GET registry.telo.run/<ns>/<name>/<version>/telo.yaml`.

The hub (`apps/hub`) is now the intended discovery surface. We want to retire the
registry as something Telo *operates and evolves* — stop maintaining the server
app, its publish path, and its CI/compose wiring — **without breaking existing
apps** that still import bare `std/x@version` refs, and move every
discovery-oriented mention in code and docs from the registry to the hub.

## Solution

The production `registry.telo.run` server **stays deployed unchanged** as the
read origin, so existing bare-ref imports keep resolving over the network —
including the dynamic version-list endpoint. Nothing on the resolve path changes:
`RegistryTransport` (reads, `cacheLocation`, `listVersions`, `digest`,
`manifestHash`), `RegistrySource`, the local manifest cache
(`local-manifest-cache-source.ts`), and `install` / `run` / `check` / `module`
are kept as-is, including `test.yml`'s live-registry smoke test. Only the
registry's *source, publish path, and surrounding tooling* leave the repo.

Everything that *writes to* or *operates* the registry is removed, and every
*discovery* path is repointed to the hub:

- **Delete the server app** — `apps/registry/` in full (manifest, Dockerfile,
  `plans/`, tests, `test-suite-e2e.yaml`, CHANGELOG). It has no npm package, so
  removal is a directory delete plus wiring cleanup. Drop its changie project
  (`.changes/registry/`, the `registry` entry in `scripts/gen-changie-config.mjs`'s
  `VERSION_LINES`).
- **Delete deployment wiring** — the `registry` service in `docker-compose.yml`,
  the `proxy` `registry.telo.localhost` alias and `depends_on`, and the dedicated
  `registry` Postgres database (reassign/rename in `scripts/db-init/`, since the
  hub shares the same Postgres server). Remove the `registry:` jobs in
  `.github/workflows/e2e.yml` and `.github/workflows/publish-docker.yml`, and the
  `apps/registry/**` path trigger.
- **Strip registry from publishing** — `telo publish` targets OCI only: a
  non-OCI (bare-host / `https://`) destination is rejected up front with a clear
  error, and `RegistryTransport.publish()` throws (the transport is
  read/resolve-only). `telo publish oci://...` via `OciTransport` stays. `--registry`
  remains, used solely to resolve/pin dependencies read-only. Remove the
  registry-push halves of `scripts/publish-packages.mjs` and
  `scripts/publish-umbrella.mjs` (OCI dual-publish stays), the `TELO_REGISTRY*` env
  in `publish.yml`, and root `package.json`'s `publish:local` / `test:e2e` /
  `test:e2e:bundle`.
- **`telo upgrade` stays fully operational** — it is transport-agnostic (it
  bumps any remote import, OCI included) and was never registry-app-specific. The
  deployed server still serves version lists and `RegistryTransport.listVersions()`
  is kept, so `telo upgrade` resolves and re-pins exactly as before. No change.
- **Repoint the authoring agent** — `apps/authoring-agent/chat/telo.yaml` moves
  its MCP wiring from `registry.telo.run/mcp` (`search_modules`) to the hub's MCP
  endpoint (`search_resources` + `get_module_manifest`); its system prompt updates
  to the hub's tool names (mandatory per the "keep the authoring agent in sync"
  rule).

## Documentation switch (registry → hub)

Every doc that presents the registry as the discovery/publish surface is rewritten
to describe the hub instead; docs describing bare-ref *resolution* stay (that path
is retained):

- `docs/coding-agents.md` — currently all registry-MCP; rewrite to the hub's MCP
  surface and tool names.
- `kernel/docs/modules.md` — rewrite §6.2 "Registry Namespaces" and §7 "Manifest
  Cache" so namespaces/discovery point at the hub while keeping the read-path cache
  description accurate.
- `docs/extend/authoring-a-module.md` — the "Publish" section drops registry push,
  keeps OCI.
- `docs/guides/getting-started.md` — CLI reference line for `telo publish` /
  "registry config".
- `pages/src/pages/for-ai.tsx` — marketing "discoverable registry" copy reframed
  around the hub.
- Plans: rewrite `plans/federated-registries.md` (obsolete server-side federation
  framing), `plans/oci-dual-publish.md` (collapse to OCI-only publish),
  `plans/module-transports.md` (OCI as default transport, registry read-only),
  `plans/federated-discovery.md` (drop the "`apps/registry` stays unchanged" lines).
- `CLAUDE.md`'s `source` bullet stays accurate (registry-ref *resolution* is
  retained).
- Changelogs are changesets/changie-generated history — not hand-edited.

### Stdlib module discovery moves to the hub

Today the standard library is *discoverable via the docs site*: the whole
"Modules" tree in `pages/sidebars.ts` embeds each `modules/<name>/README.md` +
`modules/<name>/docs/*.md`, and `pages/static/reference/std/*` holds a generated
per-module reference. Both are **unwired from Docusaurus** — remove the "Modules"
sidebar tree, the corresponding `include` globs in `pages/docusaurus.config.ts`,
and the generated `pages/static/reference/std/*` — and replaced with a single
pointer to **hub.telo.run** as the module discovery/reference surface.

The module doc **source files stay in-repo** (`modules/<name>/README.md`,
`modules/<name>/docs/*.md`) — authored next to the code as before, versioned with
it, and available for the hub to render. Only their wiring into the docs site is
removed. `CLAUDE.md`'s MANDATORY "Module Documentation" rule is rewritten
accordingly: docs still live with the module, but the requirement to wire each new
file into `pages/docusaurus.config.ts` + `pages/sidebars.ts` is dropped in favor of
"the hub surfaces module docs; the docs site links to hub.telo.run." The
kernel/core docs tree in Docusaurus (guides, kernel reference, extend) stays.

## Decisions

- **The deployed `registry.telo.run` stays up unchanged rather than going dark** —
  keeps every already-pinned `std/x@version` app running with zero migration; the
  alternative (OCI-only, registry dark) would strand bare refs not yet in cache or
  migrated to `oci://`. Only the registry's *source* leaves the repo.
- **No version-listing repoint; `telo upgrade` untouched** — an earlier plan to
  route version-listing through the hub was dropped: the hub's own tracker *shells
  out to* `telo module versions` to build its index, so repointing that verb at the
  hub's `/module/versions` would be a cycle. The server still serves version lists,
  so `RegistryTransport.listVersions()`, `telo module versions`, and `telo upgrade`
  all stay origin-direct and unchanged.
- **`telo publish` keeps OCI, loses only the registry destination** — publishing
  isn't going away, only the registry as a destination; OCI already works.
- **The runtime resolver and its tests are kept verbatim** — "remove the registry"
  means the operated server and its publish/discovery roles, not the client that
  resolves imports; conflating them would break running apps.
- **Stdlib module docs unwire from the site but stay in-repo** — hub.telo.run
  becomes the discovery/reference surface; keeping the source files next to the
  code (rejected: deleting them) preserves versioned, code-adjacent docs and lets
  the hub render from them. The MANDATORY module-docs rule shifts from "wire into
  Docusaurus" to "docs live with the module; the site links to the hub."
