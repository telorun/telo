import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpApiManifest } from "../helpers/manifests.js";
import { buildFixture, type Fixture } from "../helpers/prepare-fixture.js";
import { invokeRie, startRie, type StartedRie } from "../helpers/rie-container.js";

/** Lambda.HttpApi end-to-end. Drives a synthetic API Gateway HTTP API v2
 *  event through both bootstraps; asserts on the AWS HTTP API v2 response
 *  envelope (statusCode + headers + body + isBase64Encoded). */

interface AwsHttpApiV2Response {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

function buildHttpEvent(method: string, path: string): unknown {
  return {
    version: "2.0",
    rawPath: path,
    requestContext: {
      http: { method, path },
      stage: "$default",
    },
    headers: { accept: "application/json" },
  };
}

describe.each([
  { mode: "managed" as const },
  { mode: "custom" as const },
])("Lambda.HttpApi E2E ($mode)", ({ mode }) => {
  let fixture: Fixture;
  let rie: StartedRie;

  beforeAll(async () => {
    fixture = await buildFixture({ name: `http-api-${mode}`, telo: httpApiManifest, mode });
    rie = await startRie({ fixtureDir: fixture.dir, mode });
  });

  afterAll(async () => {
    if (rie) await rie.stop();
    if (fixture) fixture.cleanup();
  });

  it("matches a path-param route, invokes the handler, and renders an HTTP API v2 envelope", async () => {
    const response = (await invokeRie(
      rie.invokeUrl,
      buildHttpEvent("GET", "/users/42"),
    )) as AwsHttpApiV2Response;

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toBeDefined();
    expect(JSON.parse(response.body!)).toEqual({ message: "Hello 42!" });
  });

  it("returns the controller's default 404 envelope when no route matches", async () => {
    const response = (await invokeRie(
      rie.invokeUrl,
      buildHttpEvent("GET", "/no/such/route"),
    )) as AwsHttpApiV2Response;

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body!);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
