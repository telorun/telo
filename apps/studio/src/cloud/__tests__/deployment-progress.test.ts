import { describe, expect, it } from "vitest";
import { CloudApiError, type CloudApi, type Deployment, type DeploymentEvent } from "../api";
import { appOfModule } from "../app-state";
import {
  deployFailureMessage,
  deploymentFinished,
  deploymentRefusalMessage,
  followDeployment,
  type DeploymentProgress,
} from "../deployment-progress";
import { CloudUnreachableError } from "../transport";

function deployment(status: Deployment["status"]): Deployment {
  return {
    id: "dpl_1",
    environmentId: "env_1",
    status,
    source: { ref: "r", version: "1.0.0", digest: null },
    error: null,
    createdBy: "usr_1",
    createdAt: "t",
    startedAt: null,
    finishedAt: null,
    promotedFromId: null,
    rollbackOfId: null,
  };
}

const event = (seq: number, status: Deployment["status"]): DeploymentEvent => ({
  seq,
  at: "t",
  status,
  message: `${status}.`,
  code: null,
  detail: null,
});

/** One connection of the stream: the events it delivers, then how it ends. */
type Connection = { events: DeploymentEvent[]; fails?: Error };

/** A Cloud whose deployment is whatever the last delivered event said. */
function cloud(connections: Connection[], reads: Array<Error | null> = []) {
  let status: Deployment["status"] = "queued";
  const resumedFrom: Array<number | null> = [];
  const api = {
    async getDeployment() {
      const failure = reads.shift();
      if (failure) throw failure;
      return deployment(status);
    },
    async streamDeploymentEvents(
      _project: string,
      _deployment: string,
      afterSeq: number | null,
      onEvent: (event: DeploymentEvent) => void,
    ) {
      resumedFrom.push(afterSeq);
      const connection = connections.shift();
      if (!connection) return afterSeq;
      let last = afterSeq;
      for (const delivered of connection.events) {
        status = delivered.status;
        last = delivered.seq;
        onEvent(delivered);
      }
      if (connection.fails) throw connection.fails;
      return last;
    },
  } as unknown as CloudApi;
  return { api, resumedFrom };
}

async function follow(api: CloudApi): Promise<DeploymentProgress> {
  let latest: DeploymentProgress = { deployment: null, events: [], error: null, retrying: null };
  await followDeployment(api, "prj_1", "dpl_1", (progress) => (latest = progress), new AbortController().signal, 1);
  return latest;
}

describe("following a deployment", () => {
  it("reports every step once and ends when the deployment is finished", async () => {
    const { api } = cloud([{ events: [event(1, "queued"), event(2, "applying"), event(3, "healthy")] }]);
    const progress = await follow(api);
    expect(progress.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(progress.deployment?.status).toBe("healthy");
    expect(progress.error).toBeNull();
  });

  it("reopens a stream that ended early after the last event it saw", async () => {
    const { api, resumedFrom } = cloud([
      { events: [event(1, "queued"), event(2, "applying")] },
      { events: [event(3, "healthy")], fails: new CloudUnreachableError("dropped") },
    ]);
    const progress = await follow(api);
    expect(progress.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(progress.deployment?.status).toBe("healthy");
    // The first connection, the one after it, and the look for what a finished one still holds.
    expect(resumedFrom).toEqual([null, 2, 3]);
  });

  it("tries again when Cloud cannot be asked, and stops with the reason when it refuses", async () => {
    const { api } = cloud(
      [],
      [new CloudUnreachableError("dropped"), new CloudApiError(404, "not_found", {})],
    );
    const seen: DeploymentProgress[] = [];
    await followDeployment(api, "prj_1", "dpl_1", (p) => seen.push(p), new AbortController().signal, 1);
    // Said while it is tried again, not kept silent.
    expect(seen[0]).toMatchObject({ error: null, retrying: expect.stringMatching(/could not be reached/) });
    const progress = seen[seen.length - 1];
    expect(progress.deployment).toBeNull();
    expect(progress.error).not.toBeNull();
  });

  it("tries again when Cloud answers that it is asked too often", async () => {
    const { api } = cloud([{ events: [event(1, "healthy")] }], [new CloudApiError(429, "rate_limited", {})]);
    const progress = await follow(api);
    expect(progress.error).toBeNull();
    expect(progress.retrying).toBeNull();
    expect(progress.deployment?.status).toBe("healthy");
  });

  it("stops when it is told to", async () => {
    const controller = new AbortController();
    const { api } = cloud([{ events: [event(1, "queued")] }]);
    const following = followDeployment(api, "prj_1", "dpl_1", () => controller.abort(), controller.signal);
    await expect(following).resolves.toBeUndefined();
  });
});

describe("a deployment's words", () => {
  it("knows which statuses are final", () => {
    expect(["healthy", "failed", "canceled", "superseded"].every((s) => deploymentFinished(s as never))).toBe(true);
    expect(["queued", "resolving", "applying", "progressing"].some((s) => deploymentFinished(s as never))).toBe(false);
  });

  it("says the version is published whenever the deploy could not start", () => {
    for (const code of ["invalid_stage", "environment_not_found", "environment_suspended", "insufficient_role", "deploy_timeout"]) {
      expect(deployFailureMessage({ code })).toMatch(/published/);
    }
    // A placement's refusal says what to change, in its own sentence.
    expect(deployFailureMessage({ code: "tier_limit_exceeded", message: "The tier allows 1 instance." })).toBe(
      "The tier allows 1 instance.",
    );
  });

  it("tells a refused action by its code", () => {
    const refusal = (code: string) => deploymentRefusalMessage(new CloudApiError(409, code, {}));
    expect(refusal("no_rollback_candidate")).toMatch(/no earlier healthy deployment/);
    expect(refusal("source_deployment_changed")).toMatch(/Look again/);
    expect(refusal("deployment_not_cancelable")).toMatch(/no longer be canceled/);
  });
});

describe("the app of a module", () => {
  const app = (id: string, modulePath: string | null) =>
    ({ app: { id, name: id, slug: id, moduleId: null, modulePath }, environments: [] }) as never;

  it("is the one whose module is at that path, the repository root included", () => {
    const apps = [app("app_1", "services/api"), app("app_2", ""), app("app_3", null)];
    expect(appOfModule(apps, "")?.app.id).toBe("app_2");
    expect(appOfModule(apps, "services/api")?.app.id).toBe("app_1");
    expect(appOfModule(apps, "services/web")).toBeNull();
  });
});
