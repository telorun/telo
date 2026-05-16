import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqsManifest } from "../helpers/manifests.js";
import { buildFixture, type Fixture } from "../helpers/prepare-fixture.js";
import { invokeRie, startRie, type StartedRie } from "../helpers/rie-container.js";

/** Lambda.Sqs end-to-end. Drives a synthetic SQS batch event through both
 *  bootstraps; asserts the controller returns the partial-batch-failure
 *  envelope produced by the user's handler. */

interface SqsBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

function buildSqsEvent(messageIds: string[]): unknown {
  return {
    Records: messageIds.map((id) => ({
      messageId: id,
      body: "{}",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:000000000000:orders",
    })),
  };
}

describe.each([
  { mode: "managed" as const },
  { mode: "custom" as const },
])("Lambda.Sqs E2E ($mode)", ({ mode }) => {
  let fixture: Fixture;
  let rie: StartedRie;

  beforeAll(async () => {
    fixture = await buildFixture({ name: `sqs-${mode}`, telo: sqsManifest, mode });
    rie = await startRie({ fixtureDir: fixture.dir, mode });
  });

  afterAll(async () => {
    if (rie) await rie.stop();
    if (fixture) fixture.cleanup();
  });

  it("passes the handler's batchItemFailures through verbatim", async () => {
    const response = (await invokeRie(
      rie.invokeUrl,
      buildSqsEvent(["good", "bad", "good-2"]),
    )) as SqsBatchResponse;

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "bad" }]);
  });

  it("returns an empty batchItemFailures when the handler reports no per-message failures", async () => {
    const response = (await invokeRie(
      rie.invokeUrl,
      buildSqsEvent(["a", "b", "c"]),
    )) as SqsBatchResponse;

    expect(response.batchItemFailures).toEqual([]);
  });
});
