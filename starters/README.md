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
  starters.json                    # catalog index (see below)
  apps/<id>/telo.yaml              # one Telo.Application per folder (+ any text assets)
  apps/<id>/tests/*.yaml           # runs the starter and uses it from outside
  libs/<id>/telo.yaml              # one Telo.Library per folder
  libs/<id>/tests/*.yaml           # runs an importer of the library
  libs/<id>/tests/__fixtures__/    # that importer: a small application
  test-suite.yaml                  # runs every starter's own tests/
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
- A starter ships text files only. The editor copies a starter as text, so a
  binary asset (a font, an image) arrives corrupted; a starter that needs one
  is not a starter yet.
- A starter that builds on a blueprint imports it by its published ref
  (`oci://ghcr.io/telorun/blueprints/<name>@<version>#<pin>`), and pins the
  modules it shares with the blueprint at the versions the blueprint imports.
- Anything a starter reaches over the network is an input — a base URL in
  `variables:`, a key in `secrets:` — never a literal. That is what lets its
  test point it at a stand-in, and its user at their own provider.

## Tests

Every starter has at least one test, in its own `tests/` directory, run through
`starters/test-suite.yaml` (`pnpm run telo ./starters/test-suite.yaml`; a
positional argument filters by path). A starter is copied verbatim by whoever
starts from it, so each thing its description promises is asserted from the
outside.

- **An application is stood up with `App.Instance`** in a `Run.Sequence`'s
  `with:` and called over whatever it serves. Inputs are supplied by the
  starter's own names (`variables:`, `secrets:`, `ports:`), never by editing it.
- **An interactive application is a conversation**: `Channel.ReadUntil` /
  `Channel.SendLine` over the instance, declared in the same `with:`, with
  `awaitStart: false` because it blocks on its first prompt.
- **A library is reached through an importer**: a small application under
  `tests/__fixtures__/` imports it (`source: ../..`), and the test stands that
  application up with `App.Instance`. The fixture imports the published modules
  at the library's own pins — a workspace copy of a module beside the published
  copy of the same one is refused or runs as two.
- **A starter that calls a provider is tested against a stand-in**: an
  `Http.Api` declared in the test's `with:`, started before the starter and
  handed to it as its base URL. No test needs a key or the network.
- Give each test ports of its own, and write to a scratch file under `.telo/`
  or identify what it writes per run (`uuidv4()`): a starter's database
  outlives the test.
- Do not point a schedule at a date far in the future to keep it quiet — give
  the starter a switch and turn the schedule off.

## Trying starters locally

`starters/serve.yaml` serves this directory with CORS enabled, so a locally
running Studio can load the gallery from the checkout:

```sh
pnpm run starters
```

Then set Studio's **Starter gallery source** (Settings) to
`http://localhost:8787`. Files are read per request, so an edit shows the next
time the gallery opens. `STARTERS_PORT` / `--port` and `STARTERS_DIR` / `--dir`
change the port and the directory served. The starters' own `imports:` stay the
published pins they carry.

The local docker compose stack runs the same server as its `starters` service,
at `http://starters.telo.localhost:8060`, and its Studio loads the gallery from
there by default (`VITE_TELO_STARTERS_URL`); a source set in Studio's settings
still wins.
