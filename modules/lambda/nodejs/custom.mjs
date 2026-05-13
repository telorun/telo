#!/usr/bin/env node
// Shipped bootstrap for AWS Lambda custom runtimes (provided.al2023 or
// container images). Copy verbatim into your Lambda artifact root, e.g.:
//   cp node_modules/@telorun/lambda/custom.mjs ./bootstrap && chmod +x ./bootstrap
//
// AWS sets $AWS_LAMBDA_RUNTIME_API; the Lambda.Function controller observes
// it inside `run()` and starts the poll loop against the AWS Runtime API.
// `kernel.start()` blocks until SIGTERM releases the Function's kernel hold.

import { Kernel, LocalFileSource } from "@telorun/kernel";

const kernel = new Kernel({ sources: [new LocalFileSource()] });
await kernel.load("./telo.yaml");
process.once("SIGTERM", () => kernel.teardown());
await kernel.start();
