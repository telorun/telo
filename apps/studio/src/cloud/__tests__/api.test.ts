import { describe, expect, it } from "vitest";
import { CloudApi, CloudApiError } from "../api";
import { CloudUnreachableError, type CloudRequest, type CloudTransport } from "../transport";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
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
  let sessionLost = 0;
  const api = new CloudApi(transport, { onSessionLost: () => sessionLost++, sleep: async () => undefined });
  return { api, requests, sessionLost: () => sessionLost };
}

const COMMIT = { branch: "main", baseCommit: "c1", message: "m", changes: [] };

describe("CloudApi", () => {
  it("retries a commit under the same Idempotency-Key until it lands", async () => {
    const { api, requests } = scripted([
      new CloudUnreachableError("dropped"),
      json(503, { code: "overloaded", status: 503 }),
      json(502, { code: "repository_unreachable", status: 502 }),
      json(201, { commit: "c2", parent: "c1", branch: "main", message: "m", committedAt: "now" }),
    ]);
    expect((await api.commit("prj_1", COMMIT, "key-1")).commit).toBe("c2");
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((r) => r.headers?.["idempotency-key"]))).toEqual(new Set(["key-1"]));
  });

  it("does not retry a refusal, and carries its fields", async () => {
    const { api, requests } = scripted([
      json(409, { code: "branch_moved", status: 409, branch: "main", baseCommit: "c1", headCommit: "c9" }),
    ]);
    const error = await api.commit("prj_1", COMMIT, "key-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudApiError);
    expect((error as CloudApiError).code).toBe("branch_moved");
    expect((error as CloudApiError).problem.headCommit).toBe("c9");
    expect(requests).toHaveLength(1);
  });

  it("reports a lost session", async () => {
    const { api, sessionLost } = scripted([json(401, { code: "session_required", status: 401 })]);
    await expect(api.listProjects()).rejects.toMatchObject({ code: "session_required" });
    expect(sessionLost()).toBe(1);
  });

  it("reads every page of a collection", async () => {
    const { api, requests } = scripted([
      json(200, { items: [{ id: "prj_1" }], nextCursor: "abc" }),
      json(200, { items: [{ id: "prj_2" }], nextCursor: null }),
    ]);
    expect((await api.listProjects()).map((w) => w.id)).toEqual(["prj_1", "prj_2"]);
    expect(requests[1]!.path).toBe("/v1/projects?cursor=abc");
  });

  it("answers null for a head that has not moved", async () => {
    const { api, requests } = scripted([
      json(200, { branch: "main", commit: "c1", checkedAt: "now" }, { etag: '"c1"' }),
      new Response(null, { status: 304 }),
    ]);
    const first = await api.getHead("prj_1", "main");
    expect(first).toMatchObject({ head: { commit: "c1" }, etag: '"c1"' });
    expect(await api.getHead("prj_1", "main", first!.etag!)).toBeNull();
    expect(requests[1]!.headers).toEqual({ "if-none-match": '"c1"' });
  });

  it("sends a module's version as If-Match", async () => {
    const { api, requests } = scripted([json(200, { id: "mod_1", visibility: "public", version: 4 })]);
    await api.setModuleVisibility("prj_1", { id: "mod_1", version: 3 }, "public");
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      path: "/v1/projects/prj_1/modules/mod_1",
      headers: { "if-match": '"3"' },
      body: '{"visibility":"public"}',
    });
  });
});
