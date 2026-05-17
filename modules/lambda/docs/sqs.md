---
sidebar_label: Lambda.Sqs
---

# Lambda.Sqs

Working example: [`examples/aws/lambda/sqs.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/sqs.yaml).

Handle SQS message batches. One `Lambda.Sqs` resource binds one queue; AWS triggers the Lambda whenever messages arrive on that queue, batching up to your event-source-mapping's `BatchSize`. The handler receives the whole batch in a single call — you iterate inside it.

## Shape

```yaml
kind: Lambda.Sqs
metadata: { name: Orders }
queue:
  queueName: orders
  queueArn: arn:aws:sqs:us-east-1:000000000000:orders
batchSize: 10
partialBatchResponse: true
handler:
  kind: My.OrderProcessor
inputs:
  records: !cel "event.Records"
```

`queue.queueName`, `queue.queueArn`, and `batchSize` are **informational** — your deployment template (SAM / CDK / Terraform) is what wires the queue to the Lambda and sets the actual batch size on the event-source mapping. Keeping them in the manifest lets the deploy template read configuration from one place; the runtime doesn't consult them.

## Per-message granularity

AWS delivers SQS events as a batch:

```json
{ "Records": [{ "messageId": "...", "body": "...", ... }, ...] }
```

Your handler is invoked **once per batch**, not per record. Iterate inside:

```yaml
kind: JS.Script
metadata: { name: OrderProcessor }
code: |
  function main({ records }) {
    const failures = [];
    for (const record of records) {
      try {
        // per-record business logic
      } catch (err) {
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  }
```

## Partial-batch failures

With `partialBatchResponse: true` (the default), the handler can report which individual messages failed by returning:

```json
{ "batchItemFailures": [{ "itemIdentifier": "<messageId>" }, ...] }
```

`Lambda.Sqs` passes that shape through to AWS verbatim. AWS deletes the messages that succeeded (i.e. those NOT in `batchItemFailures`) and re-delivers the failed ones after the queue's visibility timeout.

Returning anything else (or nothing) signals a full-batch success — every message is deleted from the queue.

With `partialBatchResponse: false`, per-message reporting is disabled; full-batch success is reported whenever the handler returns normally. Per-message retries aren't available — an unhandled throw is the only retry mechanism.

## Unhandled exceptions

An unhandled exception from the handler is reported to AWS as a full-batch failure. Every message in the batch becomes eligible for retry, regardless of `partialBatchResponse`.

If you want per-message retries, catch inside the handler and add the failing record to the `batchItemFailures` array yourself — don't let the exception escape.
