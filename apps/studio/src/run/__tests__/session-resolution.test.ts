import { describe, expect, it } from "vitest";

import type { RunnerCredentials } from "../runner-credentials";
import { resolveSession } from "../session-resolution";
import { RunnerRefusal, type RunnerConnection, type RunnerSession, type SessionDocument } from "../types";
import { FakeRunner, app } from "./fake-runner";

function document(id: string, status: SessionDocument["status"]): SessionDocument {
  return { sessionId: id, workspace: "w", status, agent: null, apps: [] };
}

const identity: RunnerCredentials = { headers: async () => ({ authorization: "DPoP at", dpop: "proof" }) };

/** A connection whose create answers `exists` for `s-existing`, whose identity
 *  owns nothing else, and whose sessions answer reads as given. */
function connection(read: (id: string) => Promise<SessionDocument>) {
  const resumed: string[] = [];
  const conn: RunnerConnection = {
    baseUrl: "https://runner.test",
    createSession: async () => ({ kind: "exists", sessionId: "s-existing" }),
    listSessions: async () => [],
    adoptSession: async () => ({ kind: "gone" }),
    session: (id) =>
      ({
        id,
        read: () => read(id),
        resume: async () => {
          resumed.push(id);
        },
      }) as unknown as RunnerSession,
  };
  return { conn, resumed };
}

const input = {
  create: { workspace: "w", apps: [] },
  createOptions: {},
};

describe("resolving a workspace's session", () => {
  it("takes the existing session a create answers with, resuming it when suspended", async () => {
    const { conn, resumed } = connection(async (id) => document(id, { kind: "suspended" }));
    const resolved = await resolveSession({ ...input, connection: conn, stored: null, identity });
    expect(resolved.session.id).toBe("s-existing");
    expect(resolved.created).toBe(false);
    expect(resumed).toEqual(["s-existing"]);
  });

  it("reports a stored session the runner refuses for another reason, instead of replacing it", async () => {
    const { conn } = connection(async () => {
      throw new RunnerRefusal(503, "identity_provider_unavailable", "the issuer cannot be reached");
    });
    await expect(
      resolveSession({ ...input, connection: conn, stored: { sessionId: "s1", resumeSecret: "x" }, identity: null }),
    ).rejects.toThrow("the issuer cannot be reached");
  });

  it("with an identity and no stored session, finds the identity's session by listing before creating one", async () => {
    const runner = new FakeRunner();
    const created = await runner.connection.createSession({ workspace: "w", apps: [app("api")] }, { credentials: identity });
    const resolved = await resolveSession({ ...input, connection: runner.connection, stored: null, identity });
    expect(resolved).toMatchObject({ created: false, owner: "identity", resumeSecret: null });
    expect(resolved.session.id).toBe(created.sessionId);
    expect(runner.creates).toHaveLength(1);
  });

  it("with an identity, adopts the session this device holds a resume secret for, and keeps no secret", async () => {
    const runner = new FakeRunner();
    const anonymous = await runner.connection.createSession({ workspace: "w", apps: [] }, {});
    const secret = anonymous.kind === "created" ? anonymous.resumeSecret! : "";
    const resolved = await resolveSession({
      ...input,
      connection: runner.connection,
      stored: { sessionId: anonymous.sessionId, resumeSecret: secret },
      identity,
    });
    expect(resolved).toMatchObject({ created: false, owner: "identity", resumeSecret: null });
    expect(resolved.session.id).toBe(anonymous.sessionId);
    expect(runner.owners.get(anonymous.sessionId)).toBe("identity");
  });
});
