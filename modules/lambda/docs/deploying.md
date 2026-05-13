---
sidebar_label: Deploying
---

# Deploying

Telo ships no AWS-specific packaging resource. The deployment flow is a short sequence of standard commands.

## Single-Lambda backend

**1. Author the manifest** — one `Telo.Application` with one `Lambda.Function` listing your concrete handlers:

```yaml
kind: Telo.Application
metadata: { name: my-lambda, version: 1.0.0 }
targets: [Main]
---
kind: Telo.Import
metadata: { name: Lambda }
source: aws/lambda@0.1.0
---
kind: Lambda.HttpApi
metadata: { name: Web }
routes: [...]
---
kind: Lambda.Function
metadata: { name: Main }
handlers:
  - { kind: Lambda.HttpApi, name: Web }
```

The Function MUST be in `targets:`. Custom-runtime deployments call `kernel.start()`, which only runs the targeted services' `run()` method — without this line, the poll loop never starts.

**2. Install controllers hermetically:**

```bash
telo install ./telo.yaml
```

Populates `.telo/npm/` with `@telorun/lambda` and all transitive dependencies. Identical command across every Telo deployment shape.

**3. Pick the bootstrap that matches your AWS runtime.**

**Managed runtime** (`nodejs20.x` / `nodejs24.x` — AWS-provided Node.js):

```bash
cp node_modules/@telorun/lambda/managed.mjs ./index.mjs
```

The bootstrap exports `handler` — AWS calls it per invocation.

**Custom runtime** (`provided.al2023` or container image):

```bash
cp node_modules/@telorun/lambda/custom.mjs ./bootstrap
chmod +x ./bootstrap
```

The bootstrap polls the AWS Runtime API and posts responses through Telo's Function controller.

The Function controller observes `$AWS_LAMBDA_RUNTIME_API` at runtime and picks the right adapter — the **manifest itself is identical across both modes**. You can switch runtime by re-copying the other bootstrap and redeploying.

**4. Package.**

**Zip target:**

```bash
zip -r function.zip telo.yaml index.mjs .telo node_modules
```

For custom runtime, swap `index.mjs` for `bootstrap`.

**Image target:**

```dockerfile
FROM telorun/lambda-managed:0.1.0
COPY telo.yaml ${LAMBDA_TASK_ROOT}/
COPY .telo/ ${LAMBDA_TASK_ROOT}/.telo/
COPY node_modules/ ${LAMBDA_TASK_ROOT}/node_modules/
```

(The `telorun/lambda-managed` / `telorun/lambda-custom` base images ship out-of-band with `@telorun/lambda`. Track their releases at [Docker Hub](https://hub.docker.com/r/telorun/lambda-managed).)

**5. Deploy** with any AWS tool — `aws lambda update-function-code`, SAM, CDK, Terraform, Serverless, your in-house CI, etc. The deployment template's responsibilities:

- Set the AWS runtime (`nodejs24.x` for managed, `provided.al2023` for custom).
- Configure event source mappings (API Gateway, SQS event source mapping, etc.) matching the handler kinds in the manifest.
- Set the IAM role with the permissions the handler invocables need.
- For container images, point the image URI at your ECR repo (built from the Dockerfile above).

## Multi-Lambda backend

Each Lambda is its own ARN, IAM role, and scaling profile. Write **one Telo.Application manifest per Lambda** — there's no in-tree mode for one image serving multiple Lambdas (uncommon enough that the deliberate decision was to surface it via separate manifests). Shared code goes in a Lambda Layer or a shared module/import.

```
project/
├── apps/
│   ├── webhook-receiver/
│   │   └── telo.yaml        # Telo.Application with Lambda.Function named Main
│   └── order-processor/
│       └── telo.yaml        # Telo.Application with Lambda.Function named Main
└── shared/
    └── biz-logic/          # imported via Telo.Import from both apps
```

Run the 5-step flow above per app — each gets its own zip / image. Deploy independently.

## SAM template snippet (managed mode)

```yaml
Resources:
  WebhookReceiver:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./apps/webhook-receiver/build/
      Handler: index.handler
      Runtime: nodejs24.x
      Events:
        HttpApi:
          Type: HttpApi
          Properties:
            ApiId: !Ref WebApi
            Method: ANY
            Path: /{proxy+}
```

The build step (run before `sam deploy`):

```bash
cd apps/webhook-receiver
telo install ./telo.yaml
cp node_modules/@telorun/lambda/managed.mjs ./build/index.mjs
cp -r telo.yaml .telo node_modules ./build/
```

## What's not in scope

- **Pruning**: the artifact includes all resources the manifest declares, even ones a given Function doesn't dispatch to. For typical Lambda footprints this isn't measurable; if it becomes load-bearing for your project, surface it and pruning lands either as a `telo install` flag or a future `Lambda.Package` resource.
- **SnapStart**: not yet supported. Controller state semantics interact with SnapStart's checkpoint/restore in ways that need separate analysis.
- **Lambda Extensions API**: only basic `SIGTERM` handling is wired up — no Telegraph / OpenTelemetry / log-shipping extension hooks yet. When `@telorun/observability-aws` lands, these go through it.
