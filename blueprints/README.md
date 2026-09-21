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
| [`agent-app`](./agent-app) | A model, the system prompt, the tools the assistant may call | A chat API that keeps each conversation's history and runs the tool-use loop |
| [`approval-app`](./approval-app) | What a request carries, the rule that approves it automatically, what happens once it is approved or rejected | Endpoints to submit, approve, reject and track requests; a durable wait that survives restarts and runs out after a deadline |
