# Telo starter templates

Curated, working manifests the Telo editor offers on first run and when creating
a new module (the "New application / library" flow and the empty-workspace
"Start from a template" gallery).

These are **not bundled** into the editor. The editor fetches them over http(s)
from its configured templates base URL (the `templatesBaseUrl` setting, or a
built-in default when unset) using the same remote-open machinery as
`?open=<url>`, so multi-file templates — relative imports, include partials, and
listed `files:` assets — work unchanged. This directory is the unit intended to
move to its own repository; nothing here imports editor code.

## Layout

```
templates/
  templates.json        # catalog index (see below)
  apps/<id>/telo.yaml    # one Telo.Application per folder (+ any assets)
  libs/<id>/telo.yaml    # one Telo.Library per folder
```

## Catalog

`templates.json` is the gallery index the editor reads first:

```json
{
  "templates": [
    { "id": "http-api", "title": "HTTP API", "description": "…",
      "category": "app", "path": "apps/http-api/telo.yaml" }
  ]
}
```

- `category` — `app` (shown when creating an application and on onboarding) or
  `library` (shown when creating a library).
- `path` — the template's root manifest, relative to the base URL.

## Authoring rules

- Every template must pass `telo check` and be self-contained (all files under
  its own folder).
- Write **all** CEL with the `!cel` tag, never inline `${{ }}` — templates are
  opened and round-tripped through the editor, which normalizes to `!cel`.
- List `files:` assets explicitly (no globs); a raw URL can't enumerate a glob.
- Hosting must serve `templates.json` and every manifest/asset with CORS enabled.
