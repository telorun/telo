---
sidebar_label: Deploying
---

# Deploying

Telo ships no Lambda-specific packaging tool. The flow is `telo install` + `cp` + `zip` (or `docker build`), then your usual AWS deploy tool.

Working examples to start from: [`examples/aws/lambda/`](https://github.com/telorun/telo/tree/main/examples/aws/lambda) (one per handler kind, plus a multi-kind setup).

## One Lambda

**1. Author the manifest** with one `Telo.Application`, your handler resources, and one `Lambda.Function` listing them as `handlers:`. The Function MUST be in `targets:` — under the custom runtime model, Telo only starts the AWS-event loop for resources listed there.

```yaml
kind: Telo.Application
metadata: { name: my-lambda, version: 1.0.0 }
targets: [Main]
---
kind: Telo.Import
metadata: { name: Lambda }
source: aws/lambda@0.2.1
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

**2. Install dependencies** hermetically into `.telo/npm/`:

```bash
telo install ./telo.yaml
```

Same command Telo uses for any deployment — pre-downloads everything the manifest depends on, so the Lambda never hits the network at boot.

**3. Pick a runtime model and copy the matching bootstrap.**

**Managed Node (`nodejs24.x`)** — AWS invokes your exported handler per event:

```bash
cp node_modules/@telorun/lambda/managed.mjs ./index.mjs
```

Point AWS at `index.handler`. Use this unless you have a specific reason not to.

**Custom (`provided.al2023` or container image)** — Telo runs the event loop itself:

```bash
cp node_modules/@telorun/lambda/custom.mjs ./bootstrap
chmod +x ./bootstrap
```

The Function detects which model it's under via `$AWS_LAMBDA_RUNTIME_API` at runtime. **The manifest is identical** in both cases — you can swap models by recopying the other bootstrap and redeploying.

**4. Package.**

Zip target:

```bash
zip -r function.zip telo.yaml index.mjs .telo node_modules
```

Swap `index.mjs` for `bootstrap` if you copied the custom bootstrap.

Image target:

```dockerfile
FROM telorun/lambda-managed:latest
COPY telo.yaml ${LAMBDA_TASK_ROOT}/
COPY .telo/ ${LAMBDA_TASK_ROOT}/.telo/
COPY node_modules/ ${LAMBDA_TASK_ROOT}/node_modules/
```

`telorun/lambda-managed` (and `telorun/lambda-custom` for the custom variant) extends the AWS Lambda base image with Telo's runtime pre-installed. Your Dockerfile only adds the manifest, the install root, and your handler code.

**5. Deploy** with `aws lambda update-function-code`, SAM, CDK, Terraform, Serverless, or your own pipeline. The deployment template's job:

- Set the AWS runtime (`nodejs24.x` for managed, `provided.al2023` for custom).
- Configure event source mappings (API Gateway, SQS event source mapping, EventBridge target, etc.) matching the handler kinds in your manifest.
- Set the IAM role with the permissions your handlers need.
- For container images: point the image URI at your ECR repo (built from the Dockerfile above).

## Multiple Lambdas in one project

Each Lambda is its own AWS function with its own ARN, IAM role, and scaling profile. Write **one Telo.Application manifest per Lambda** and package each independently — Telo doesn't ship a one-image-many-Lambdas mode.

```
project/
├── apps/
│   ├── webhook-receiver/
│   │   └── telo.yaml
│   └── order-processor/
│       └── telo.yaml
└── shared/
    └── biz-logic/         # imported via Telo.Import from both apps
```

Run the five-step flow above per app. Shared code goes through `Telo.Import` (in the manifest) or a Lambda Layer (on the AWS side).

## SAM example (managed mode)

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
mkdir -p ./build
cp node_modules/@telorun/lambda/managed.mjs ./build/index.mjs
cp -r telo.yaml .telo node_modules ./build/
```

## Known limitations

- **SnapStart** isn't supported.
- **Lambda Extensions** — only basic `SIGTERM` handling is wired up; no log-shipping or OpenTelemetry extension hooks yet.
