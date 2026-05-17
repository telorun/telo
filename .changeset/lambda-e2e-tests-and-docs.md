---
"@telorun/lambda": patch
---

Add E2E test suite and rewrite module documentation.

`modules/lambda/nodejs/tests/e2e/` — testcontainers-driven end-to-end tests against the AWS Lambda Runtime Interface Emulator, covering `Lambda.Direct`, `Lambda.HttpApi`, and `Lambda.Sqs` in both managed (`nodejs24.x`) and custom (`provided.al2023`-style) runtime models. Each test packs the workspace into a fixture, runs `telo install` against the real public registry, bind-mounts the fixture into the AWS Lambda runtime image, and drives the bootstrap through RIE. 12 cases total; CI job in `.github/workflows/e2e.yml`. `testcontainers` added as a devDependency.

Documentation under `modules/lambda/README.md` and `modules/lambda/docs/*` rewritten as a user guide: removed version pins from prose (only manifests and source: refs keep them), dropped internal-implementation jargon (controller/classifier/dispatcher language replaced with kind names), and removed "v1 surface" / future-plans laundry lists. Added working example manifests under `examples/aws/lambda/` (one per handler kind plus a multi-kind setup), all linked from the module docs.
