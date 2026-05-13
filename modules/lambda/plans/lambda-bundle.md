# Plan — Lambda artifact bundling

Goal: zero-friction packaging of Lambda deployment artifacts as Telo flows. User runs one shell command with no local manifest authoring. Builds on the [Lambda function adapter](./lambda-function.md), which defines the runtime side — this plan covers how a manifest becomes an uploadable artifact.

Hard constraint: no AWS-specific knowledge in `@telorun/cli`. Bundling is manifest-driven; the CLI stays cloud-agnostic.

## Scope

In-scope:

- `Lambda.Bundle` resource kind shipped from `modules/lambda`.
- Runnable bundler Application (`std/lambda-bundle`) shipped alongside the Library.
- Two bundle targets — zip and container image — across both runtime modes.
- Telo Lambda base images (`telorun/lambda-managed`, `telorun/lambda-custom`) for the image target.

Out of scope:

- Deployment / upload (Lambda function code update). Composes via other resources (`S3.Put`, future `Aws.LambdaUpdateFunctionCode`); not part of this plan.
- A `telo bundle` CLI command. Explicitly not built — bundling stays manifest-driven so `@telorun/cli` doesn't grow AWS knowledge.

## Change

### `Lambda.Bundle` resource kind

Add to `modules/lambda/telo.yaml` alongside `Lambda.Function`:

```yaml
kind: Telo.Definition
metadata: { name: Bundle }
capability: Telo.Runnable
controllers:
  - pkg:npm/@telorun/lambda@0.1.0?local_path=./nodejs#bundle
schema:
  type: object
  properties:
    input:    { type: string }     # path to user's app manifest
    output:   { type: string }     # output directory
    runtime:  { enum: [managed, custom], default: managed }
    target:   { enum: [zip, image], default: zip }
  required: [input, output]
```

Export from the Library: `exports.kinds: [Function, Bundle]`.

Controller `run()` performs:

1. **Load + analyze `input`** — reuse `Loader` + `StaticAnalyzer` the same way [`commands/install.ts:55-67`](../../../cli/nodejs/src/commands/install.ts#L55-L67) and [`commands/check.ts`](../../../cli/nodejs/src/commands/check.ts) do. Fail on analysis errors.
2. **Validate target** — the input manifest must contain exactly one `Lambda.Function` resource; its `runtime` field must match the bundle's `runtime` (or be unset, in which case the bundle fills it in before emitting).
3. **Inline includes + canonicalize imports** — extract `expandAndInlineIncludes` and `canonicalizeRelativeImports` from [`cli/nodejs/src/commands/publish.ts`](../../../cli/nodejs/src/commands/publish.ts) into a shared module (`cli/nodejs/src/bundling.ts` or a new `@telorun/manifest-bundling` package) and reuse them here.
4. **Pre-install controllers** — same flow as [`commands/install.ts`](../../../cli/nodejs/src/commands/install.ts) populates `<output>/.telo/npm/`. Hermetic — no registry calls at Lambda boot.
5. **Bundle kernel + sdk + adapter** — copy the resolved `node_modules` subtree for `@telorun/kernel`, `@telorun/sdk`, `@telorun/analyzer`, `@telorun/lambda`, and every controller package referenced by the input. Lambda doesn't run `npm install` — the bundle must be a flat, hermetic `node_modules`.
6. **Emit the bootstrap** — write `<output>/index.mjs` for `runtime: managed`, or `<output>/bootstrap` (executable bit set) for `runtime: custom`. Contents are defined in [lambda-function.md](./lambda-function.md#bootstrap-entry-points).
7. **Finalize per `target`** — `target: zip` produces `<output>/function.zip`. `target: image` writes a `Dockerfile` `FROM` the matching base image; user builds and pushes.

Output shape (`target: zip`, `runtime: managed`):

```
<output>/
├── index.mjs
├── telo.yaml
├── node_modules/
│   ├── @telorun/{kernel,sdk,analyzer,lambda}/
│   └── <controller packages>/
├── .telo/npm/
└── function.zip
```

Path resolution: `input` and `output` resolve relative to the bundle manifest's directory, same convention as `Telo.Import.source` and `include:`.

### `std/lambda-bundle` Application

Shipped from `modules/lambda/bundle.yaml`, published as a sibling registry artifact:

```yaml
kind: Telo.Application
metadata: { name: lambda-bundle, version: 0.1.0 }
targets: [Out]
---
kind: Telo.Import
metadata: { name: Lambda }
source: std/lambda@0.1.0
---
kind: Lambda.Bundle
metadata: { name: Out }
# input / output / runtime / target read from argv by the controller via ctx.args
```

The `Lambda.Bundle` controller reads its config from `ctx.args` ([`ParsedArgs`](../../../sdk/nodejs/src/types.ts)) when the manifest fields are absent. Matches the pattern `@telorun/test` already uses for `--filter` ([`modules/test/nodejs/src/suite.ts`](../../test/nodejs/src/suite.ts)).

Precedence: manifest fields win when both are set. Lets a power user write their own `Lambda.Bundle` with all fields pinned in YAML while the shipped Application drives everything from argv.

User invocation, zero local files:

```bash
telo run std/lambda-bundle@0.1.0 -- \
  --input ./app.yaml \
  --output ./dist \
  --runtime managed \
  --target zip
```

### Two-artifact publish

The registry maps `<namespace>/<name>/<version>` → single manifest, so:

- `std/lambda@0.1.0` — Library declaring `Lambda.Function` + `Lambda.Bundle`.
- `std/lambda-bundle@0.1.0` — Application that imports the Library and runs the bundle from argv.

Versioned together, single PR, single changeset. Bumped in lockstep going forward.

The Library is the general path — users who want to compose bundling with other resources (e.g. bundle → `S3.Put` → invoke a Lambda-update kind) import the Library and use `Lambda.Bundle` in their own manifest. The Application is the fast path for the common case.

### Telo Lambda base images

For `target: image`, ship two base images so users don't repackage Node + kernel + adapter themselves:

- `telorun/lambda-managed:<version>` — `FROM public.ecr.aws/lambda/nodejs:20`, pre-installs `@telorun/kernel`, `@telorun/sdk`, `@telorun/analyzer`, `@telorun/lambda` into `${LAMBDA_TASK_ROOT}/node_modules/`. `CMD ["index.handler"]`.
- `telorun/lambda-custom:<version>` — `FROM public.ecr.aws/lambda/provided:al2023`, ships a Node.js binary plus the same kernel packages, entry `/var/runtime/bootstrap`.

Built from `apps/lambda-base-image/managed/` and `apps/lambda-base-image/custom/`, mirroring the existing [`telorun/telo` docker image](../../../apps/docker-runner). Versions track the Library. Separate release workflow (container registry, no npm changeset).

The bundler's `target: image` finalization writes a Dockerfile referencing the matching base-image version (read from `@telorun/lambda`'s own `package.json`).

## Why this shape

- **Manifest-driven, not CLI-driven** — keeps `@telorun/cli` cloud-agnostic. Same architectural rule that puts S3 in `modules/s3` rather than baking S3 into the CLI.
- **Two artifacts** — Library for composition, Application for zero-friction. Same pattern any "shipped-runnable" stdlib tool will reuse; not Lambda-specific scaffolding.
- **Reuse of `publish.ts` helpers** — inline-and-canonicalize logic already exists for publish; extracting it into a shared module benefits both publish and bundle.
- **`Lambda.Bundle` as a controller, not `JS.Script`** — per CLAUDE.md, JS.Script is a last resort. Bundling has reusable composite logic (file copy, package resolution, zip creation, bootstrap emission) that's worth a dedicated controller. Confirms the project rule by explicit choice.

## Test

1. **Unit tests** — `modules/lambda/nodejs/tests/bundle.test.ts` (vitest). Drive `Lambda.Bundle` programmatically against fixture manifests, assert output layout, bootstrap contents per mode, hermetic `node_modules`, Dockerfile content for image targets.
2. **Smoke against RIE** — CI job runs the bundler, then runs the resulting artifact under [aws-lambda-runtime-interface-emulator](https://github.com/aws/aws-lambda-runtime-interface-emulator) and confirms a sample invocation works end-to-end. Covers the seam between this plan and [lambda-function.md](./lambda-function.md).

## Docs

- `modules/lambda/docs/packaging.md` — `Lambda.Bundle` reference, `std/lambda-bundle` walkthrough with copy-paste examples for the four `runtime × target` combinations, IAM policy template, SAM/CDK examples showing how to plug bundle output into a deployment template.

Add to [`pages/docusaurus.config.ts`](../../../pages/docusaurus.config.ts) and [`pages/sidebars.ts`](../../../pages/sidebars.ts).

## Changeset

- `@telorun/lambda` — minor bump (Bundle controller added).
- `std/lambda@0.1.0` and `std/lambda-bundle@0.1.0` — both published to the Telo registry together.
- Container artifacts `telorun/lambda-managed`, `telorun/lambda-custom` — separate release workflow.

## Open questions

- **Base image registry**: Docker Hub (mirrors existing `telorun/telo`) vs AWS ECR Public (lower egress for AWS users). Could publish to both.
- **Bundler controller package boundary**: same `@telorun/lambda` as the Function controller, or a sibling `@telorun/lambda-bundle`? Same-package is simpler; split-package keeps the Lambda runtime artifact smaller (bundler deps don't ship to production). Decide before first publish.
