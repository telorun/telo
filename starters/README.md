# Telo starters

A starter is a working manifest the Telo editor copies once into the user's
workspace — on first run ("Start from a starter") and when creating a new
module (the "New application / library" flow). After the copy it is the user's
own code: nothing links it back to this directory, and later changes here do
not reach it.

A starter is not a *blueprint* (an importable library under `blueprints/` that
exports a templated application kind), and "template" in Telo means only the
body of a templated definition (`docs/extend/templated-definitions.md`). A
starter may import a blueprint; that is how a blueprint is offered in the
editor.

Starters are **not bundled** into the editor. The editor fetches them over
http(s) from its configured starters base URL (the `startersBaseUrl` setting, or
a built-in default when unset) using the same remote-open machinery as
`?open=<url>`, so multi-file starters — relative imports, include partials, and
listed `files:` assets — work unchanged. This directory is the unit intended to
move to its own repository; nothing here imports editor code.

## Layout

```
starters/
  starters.json          # catalog index (see below)
  apps/<id>/telo.yaml    # one Telo.Application per folder (+ any assets)
  libs/<id>/telo.yaml    # one Telo.Library per folder
  test-suite.yaml        # runs every starter's own tests/
```

## Catalog

`starters.json` is the gallery index the editor reads first:

```json
{
  "starters": [
    { "id": "http-api", "title": "HTTP API", "description": "…",
      "category": "app", "path": "apps/http-api/telo.yaml" }
  ]
}
```

- `category` — `app` (shown when creating an application and on onboarding) or
  `library` (shown when creating a library).
- `path` — the starter's root manifest, relative to the base URL.

## Authoring rules

- Every starter must pass `telo check` and be self-contained (all files under
  its own folder).
- Write **all** CEL behind a tag — `!cel` for a computed value, `!interpolate`
  for text with values in it — never a plain string holding `${{ }}`, which is
  not evaluated.
- List `files:` assets explicitly (no globs); a raw URL can't enumerate a glob.
- Hosting must serve `starters.json` and every manifest/asset with CORS enabled.
- A starter's tests live in its own `tests/` directory and run through
  `starters/test-suite.yaml` (`pnpm run telo ./starters/test-suite.yaml`).
