# Blueprints

A blueprint is a library exporting a templated definition that describes a
whole application (see
[templated definitions](../docs/extend/templated-definitions.md)). An app built
on one declares a single resource of that kind and fills in only what is
specific to it; the infrastructure the shape needs comes from the kind's
template body.

A blueprint is imported, not copied: an app keeps receiving its fixes by
bumping the import. It is offered in Studio through a starter (`starters/`)
that imports it — the starter is copied once into the user's workspace, the
blueprint stays a dependency.

A blueprint is ordinary Telo: the kernel runs it, `telo check` type-checks it,
it is published and imported like any module, and switching to full editing is
replacing the one resource with the resources its template body declares.

| Blueprint | What an app declares | What it gets |
|---|---|---|
| [`workflow-app`](./workflow-app) | A list of workflows: path, request mapping, steps, response | An HTTP server serving each workflow as its own endpoint, with an OpenAPI document |
