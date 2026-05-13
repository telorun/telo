---
sidebar_label: Lambda.Sqs
---

# Lambda.Sqs

SQS queue trigger. One queue per `Lambda.Sqs` resource (standard AWS pattern). The Function dispatches the full batch event to the handler in a single invoke call; the handler iterates records internally and may return per-message retry information.

## Shape

```yaml
kind: Lambda.Sqs
metadata: { name: Orders }
queue:
  queueName: orders            # informational; AWS-side event source mapping
  queueArn: arn:aws:sqs:...:orders
batchSize: 10                  # informational; AWS event-source-mapping field
partialBatchResponse: true     # default
handler: { kind: My.OrderProcessor }
inputs:
  records: !cel "event.Records"
```

`queue.queueName` and `batchSize` are **informational** — AWS configures the actual event-source mapping (queue ARN, batch size, visibility timeout, etc.) via SAM / CDK / Terraform. The manifest captures the values so the deployment template can read them from one place, but the runtime doesn't consult them.

## Invocation contract

The handler is invoked **once per Lambda invocation**, not per record. The full batch arrives via the `event.Records[]` array; iterate inside the handler:

```yaml
kind: JavaScript.Script
metadata: { name: ProcessRecords }
code: |
  function main({ records }) {
    const failures = [];
    for (const record of records) {
      try {
        // … per-record business logic
      } catch (err) {
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  }
```

This matches AWS's SQS event-source-mapping semantics — Lambda hands you the whole batch, and partial-failure reporting is a return-value contract.

## Partial-batch responses

`partialBatchResponse: true` (default): the controller passes the handler's `batchItemFailures` array through to AWS. Returning `{ batchItemFailures: [] }` (or any non-conforming shape) signals full-batch success.

`partialBatchResponse: false`: the controller always returns `{ batchItemFailures: [] }`. Per-message retries are not available — an unhandled throw is the only retry mechanism (AWS retries the entire batch).

## Throws

Unhandled exceptions from the handler propagate out of `invoke()` to the Function's poll loop, which posts the error to the AWS Runtime API. AWS treats this as a full-batch failure regardless of `partialBatchResponse`.

`InvokeError` (declared via the handler's `throws:` field) is treated identically — the controller does not currently catch errors and translate them into `batchItemFailures`. If you need that pattern, catch inside the handler and add the failing record to the response array yourself.
