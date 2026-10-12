import { describe, expect, it } from "vitest";
import { CloudApi, type DeploymentEvent } from "../api";
import { CloudUnreachableError, type CloudRequest, type CloudTransport } from "../transport";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An event stream delivered in the given chunks, whatever frames they cut. */
function stream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function scripted(answers: Array<Response | Error>) {
  const requests: CloudRequest[] = [];
  const transport: CloudTransport = {
    async request(request) {
      requests.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error("no scripted answer left");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const api = new CloudApi(transport, { onSessionLost: () => undefined, sleep: async () => undefined });
  return { api, requests };
}

const frame = (seq: number, status: string) =>
  `id: ${seq}\ndata: ${JSON.stringify({ seq, at: "t", status, message: `${status}.`, code: null, detail: null })}\n\n`;

describe("CloudApi: projects", () => {
  it("creates a project on the placement it is given, and on none when it is given none", async () => {
    const { api, requests } = scripted([
      json(201, { id: "prj_1", name: "Shop", slug: "shop", effectiveRole: "admin" }),
      json(201, { id: "prj_2", name: "Blog", slug: "blog", effectiveRole: "admin" }),
    ]);
    await api.createProject({
      name: "Shop",
      slug: "shop",
      placement: { kind: "subscription", subscriptionId: "sub_1" },
    });
    await api.createProject({ name: "Blog", slug: "blog" });
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ["POST", "/v1/projects"],
      ["POST", "/v1/projects"],
    ]);
    expect(JSON.parse(requests[0].body!)).toEqual({
      name: "Shop",
      slug: "shop",
      placement: { kind: "subscription", subscriptionId: "sub_1" },
    });
    expect(JSON.parse(requests[1].body!)).toEqual({ name: "Blog", slug: "blog" });
  });

  it("reads an organization without a registry namespace as none, and any other refusal as one", async () => {
    const { api } = scripted([
      json(404, { code: "not_found", status: 404 }),
      json(503, { code: "overloaded", status: 503 }),
    ]);
    expect(await api.getRegistryNamespace()).toBeNull();
    await expect(api.getRegistryNamespace()).rejects.toMatchObject({ code: "overloaded" });
  });
});

describe("CloudApi: publications", () => {
  it("names the stage to deploy to only when there is one", async () => {
    const { api, requests } = scripted([json(202, { id: "pub_1" }), json(202, { id: "pub_2" })]);
    const request = { modulePath: "", commit: "c1", teloVersion: "0.110.0" };
    await api.createPublication("prj_1", { ...request, deploy: { stageId: "stg_1" } }, "k1");
    await api.createPublication("prj_1", request, "k2");
    expect(JSON.parse(requests[0].body!).deploy).toEqual({ stageId: "stg_1" });
    expect("deploy" in JSON.parse(requests[1].body!)).toBe(false);
  });
});

describe("CloudApi: deployments", () => {
  it("sends every deployment action once, under its Idempotency-Key, however often it is retried", async () => {
    const { api, requests } = scripted([
      new CloudUnreachableError("dropped"),
      json(202, { id: "dpl_1" }),
      json(202, { id: "dpl_2" }),
      json(202, { id: "dpl_3" }),
      json(202, { id: "dpl_4" }),
      json(202, { id: "dpl_5" }),
    ]);
    await api.deploy("prj_1", "env_1", "1.2.0", "k-deploy");
    await api.rollback("prj_1", "env_1", "k-rollback");
    await api.promote(
      "prj_1",
      "env_1",
      { sourceEnvironmentId: "env_0", sourceDeploymentId: "dpl_0" },
      "k-promote",
    );
    await api.restart("prj_1", "env_1", "k-restart");
    await api.redeploy("prj_1", "env_1", "k-redeploy");
    expect(requests.map((r) => [r.path.split("/").pop(), r.headers?.["idempotency-key"]])).toEqual([
      ["deployments", "k-deploy"],
      ["deployments", "k-deploy"],
      ["rollback", "k-rollback"],
      ["promote", "k-promote"],
      ["restart", "k-restart"],
      ["redeploy", "k-redeploy"],
    ]);
    expect(JSON.parse(requests[1].body!)).toEqual({ version: "1.2.0" });
    // The newest healthy deployment before the current one: none is named.
    expect(JSON.parse(requests[2].body!)).toEqual({});
    expect(JSON.parse(requests[3].body!)).toEqual({
      sourceEnvironmentId: "env_0",
      sourceDeploymentId: "dpl_0",
    });
    expect(requests[4].body).toBeUndefined();
  });

  it("reads the events of a stream whatever chunks cut its frames into, skipping keepalives", async () => {
    const text = `${frame(1, "queued")}: keepalive\n\n${frame(2, "applying")}${frame(3, "healthy")}`;
    const { api, requests } = scripted([
      stream([text.slice(0, 17), text.slice(17, 60), text.slice(60)]),
    ]);
    const events: DeploymentEvent[] = [];
    const last = await api.streamDeploymentEvents(
      "prj_1",
      "dpl_1",
      null,
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events.map((event) => [event.seq, event.status])).toEqual([
      [1, "queued"],
      [2, "applying"],
      [3, "healthy"],
    ]);
    expect(last).toBe(3);
    expect(requests[0].headers?.["last-event-id"]).toBeUndefined();
  });

  it("resumes a stream after the last event seen, and takes 204 as nothing left", async () => {
    const { api, requests } = scripted([new Response(null, { status: 204 })]);
    const last = await api.streamDeploymentEvents(
      "prj_1",
      "dpl_1",
      7,
      () => {
        throw new Error("nothing was left to report");
      },
      new AbortController().signal,
    );
    expect(last).toBe(7);
    expect(requests[0].headers?.["last-event-id"]).toBe("7");
  });

  it("names a config key in the path as it is typed, encoded", async () => {
    const { api, requests } = scripted([
      json(201, { key: "A B", isSecret: true, value: null, updatedAt: "t" }),
      new Response(null, { status: 204 }),
    ]);
    await api.setConfig("prj_1", "env_1", "A B", { value: "s3cret", isSecret: true });
    await api.deleteConfig("prj_1", "env_1", "A B");
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ["PUT", "/v1/projects/prj_1/environments/env_1/config/A%20B"],
      ["DELETE", "/v1/projects/prj_1/environments/env_1/config/A%20B"],
    ]);
    expect(JSON.parse(requests[0].body!)).toEqual({ value: "s3cret", isSecret: true });
  });
});
