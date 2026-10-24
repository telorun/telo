import { describe, expect, it } from "vitest";

import type { RunnerCredentials } from "../runner-credentials";
import { adoptDeviceSessions } from "../session-adoption";
import type { AdoptedSession } from "../types";
import type { WorkspaceIdentity } from "../workspace-session";
import type { WorkspaceSessionEntry } from "../workspace-session-entry";
import { FakeRunner, memoryResumeSecretStore } from "./fake-runner";

const credentials: RunnerCredentials = { headers: async () => ({ authorization: "DPoP at", dpop: "proof" }) };
const identity: WorkspaceIdentity = { issuer: "https://issuer.test", credentials: () => credentials };

/** A runner that accepts the identity, answering adoption as given. */
function identityRunner(answer: AdoptedSession) {
  const runner = new FakeRunner();
  runner.connection.baseUrl = "https://runner.test";
  runner.capabilities = {
    ...runner.capabilities,
    identity: { resource: "https://runner.test", authorization_servers: ["https://issuer.test"] },
  };
  const adopted: Array<{ sessionId: string; resumeSecret: string }> = [];
  runner.connection.adoptSession = async (sessionId, resumeSecret) => {
    adopted.push({ sessionId, resumeSecret });
    return answer;
  };
  return { runner, adopted };
}

async function adopt(answer: AdoptedSession) {
  const { runner, adopted } = identityRunner(answer);
  const secrets = memoryResumeSecretStore();
  const scope = { runner: "r1", workspaceKey: "/ws" };
  await secrets.write(scope, "secret-s1");
  const saved: WorkspaceSessionEntry[] = [];
  const [outcome] = await adoptDeviceSessions({
    targets: [
      {
        workspaceKey: "/ws",
        entry: { mode: "manual", workspace: "device:1", runner: "r1", sessionId: "s1" },
        runner: { id: "r1", adapter: runner.adapter, config: {} },
      },
    ],
    secrets,
    identity,
    saveEntry: (key, entry) => saved.push(entry),
  });
  return { outcome, adopted, saved, secret: await secrets.read(scope) };
}

describe("adopting this device's sessions on sign-in", () => {
  it("makes a resume-secret session the identity's and deletes the secret", async () => {
    const result = await adopt({ kind: "adopted", sessionId: "s1" });
    expect(result.adopted).toEqual([{ sessionId: "s1", resumeSecret: "secret-s1" }]);
    expect(result.outcome).toEqual({ workspaceKey: "/ws", kind: "adopted", sessionId: "s1" });
    expect(result.saved).toEqual([{ mode: "manual", workspace: "device:1", runner: "r1", sessionId: "s1", owner: "identity" }]);
    expect(result.secret).toBeNull();
  });

  it("switches to the identity's existing session for the workspace and forgets the secret", async () => {
    const result = await adopt({ kind: "exists", sessionId: "s9" });
    expect(result.outcome).toEqual({ workspaceKey: "/ws", kind: "switched", sessionId: "s9" });
    expect(result.saved).toEqual([{ mode: "manual", workspace: "device:1", runner: "r1", sessionId: "s9", owner: "identity" }]);
    expect(result.secret).toBeNull();
  });

  it("forgets a secret that opens nothing, and the session id with it", async () => {
    const result = await adopt({ kind: "gone" });
    expect(result.outcome).toEqual({ workspaceKey: "/ws", kind: "forgotten" });
    expect(result.saved).toEqual([{ mode: "manual", workspace: "device:1", runner: "r1" }]);
    expect(result.secret).toBeNull();
  });
});
