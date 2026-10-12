import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CloudApi,
  DeploymentSummary,
  EnvironmentState,
  ProjectRole,
} from "../../../cloud/api";
import { EnvironmentCard } from "./EnvironmentCard";

afterEach(() => cleanup());

function summary(id: string, overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    id,
    status: "healthy",
    trigger: "deploy",
    version: "1.2.0",
    digest: null,
    errorCode: null,
    createdAt: "2026-10-12T10:00:00Z",
    finishedAt: "2026-10-12T10:01:00Z",
    ...overrides,
  };
}

function stage(
  name: string,
  overrides: Partial<EnvironmentState["environment"]> = {},
  deployments: Partial<Pick<EnvironmentState, "currentDeployment" | "latestDeployment">> = {},
): EnvironmentState {
  const current = summary(`dpl_${name}`);
  return {
    environment: {
      id: `env_${name}`,
      appId: "app_1",
      stageId: `stg_${name}`,
      name,
      slug: name.toLowerCase(),
      protected: false,
      suspended: false,
      health: "healthy",
      replicas: 1,
      readyReplicas: 1,
      currentDeploymentId: current.id,
      configChangedSinceDeploy: false,
      placementName: "Cluster",
      ...overrides,
    },
    currentDeployment: current,
    latestDeployment: current,
    ...deployments,
  };
}

function card(entry: EnvironmentState, role: ProjectRole = "deployer", others: EnvironmentState[] = []) {
  const deployment = { id: "dpl_new" };
  const api = {
    deploy: vi.fn(async () => deployment),
    rollback: vi.fn(async () => deployment),
    promote: vi.fn(async () => deployment),
    restart: vi.fn(async () => deployment),
    redeploy: vi.fn(async () => deployment),
    cancelDeployment: vi.fn(async () => deployment),
    listDeployments: vi.fn(async () =>
      [entry.latestDeployment, entry.currentDeployment]
        .filter((d, i, all) => d !== null && all.findIndex((o) => o?.id === d.id) === i)
        .map((d) => ({
          id: d!.id,
          status: d!.status,
          createdAt: d!.createdAt,
          source: { ref: "r", version: d!.version, digest: null },
          rollbackOfId: null,
          promotedFromId: null,
        })),
    ),
    getDeployment: vi.fn(async () => ({
      id: entry.latestDeployment?.id,
      environmentId: entry.environment.id,
      status: entry.latestDeployment?.status ?? "healthy",
      source: { ref: "r", version: "1.3.0", digest: null },
      error:
        entry.latestDeployment?.status === "failed"
          ? { code: "rollout_failed", message: "The new version did not become ready.", detail: null }
          : null,
    })),
    // Never ends: the deployment is followed for as long as the card is shown.
    streamDeploymentEvents: vi.fn(() => new Promise<number | null>(() => undefined)),
  };
  const onChanged = vi.fn();
  render(
    <EnvironmentCard
      api={api as unknown as CloudApi}
      projectId="prj_1"
      role={role}
      entry={entry}
      others={others}
      versions={[]}
      consoleUrl="https://console.telo.cloud/p/prj_1/apps/app_1/env/env_1"
      onChanged={onChanged}
    />,
  );
  return { api, onChanged };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("a stage of an application in Telo Cloud", () => {
  it("shows what serves and how it is doing", () => {
    card(stage("Production"));
    expect(screen.getByText("1.2.0")).toBeTruthy();
    expect(screen.getByText(/Running · 1\/1 ready/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Console/ }).getAttribute("href")).toContain("/env/env_1");
  });

  it("reverts to the previous version only after it is confirmed", async () => {
    const { api, onChanged } = card(stage("Production"));
    fireEvent.click(button("Revert to previous version"));
    expect(api.rollback).not.toHaveBeenCalled();
    fireEvent.click(await waitFor(() => button("Revert")));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.rollback).toHaveBeenCalledWith("prj_1", "env_Production", expect.any(String));
  });

  it("promotes exactly the deployment the other stage was seen to serve", async () => {
    const { api } = card(stage("Production"), "deployer", [stage("Staging")]);
    fireEvent.click(button("Promote from Staging"));
    fireEvent.click(await waitFor(() => button("Promote")));
    await waitFor(() => expect(api.promote).toHaveBeenCalled());
    expect(api.promote).toHaveBeenCalledWith(
      "prj_1",
      "env_Production",
      { sourceEnvironmentId: "env_Staging", sourceDeploymentId: "dpl_Staging" },
      expect.any(String),
    );
  });

  it("offers no stage to promote from that serves nothing", () => {
    card(stage("Production"), "deployer", [
      stage("Staging", { currentDeploymentId: null }, { currentDeployment: null, latestDeployment: null }),
    ]);
    expect(screen.queryByRole("button", { name: /Promote from/ })).toBeNull();
  });

  it("lets a viewer read and nothing else", () => {
    card(stage("Production"), "viewer");
    expect(button("Revert to previous version").disabled).toBe(true);
    expect(button("Restart").disabled).toBe(true);
    expect(screen.getByText(/only reads/)).toBeTruthy();
  });

  it("keeps a protected stage for project admins", () => {
    card(stage("Production", { protected: true }), "deployer");
    expect(button("Restart").disabled).toBe(true);
    expect(screen.getByText(/needs the project role admin/)).toBeTruthy();
    cleanup();
    card(stage("Production", { protected: true }), "admin");
    expect(button("Restart").disabled).toBe(false);
  });

  it("deploys nothing to a stopped stage, and offers no way to start or stop it", () => {
    card(stage("Production", { suspended: true }));
    expect(button("Restart").disabled).toBe(true);
    expect(screen.getByText(/stopped in this stage/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stop|Start|Suspend|Resume|Delete/ })).toBeNull();
  });

  it("offers to apply changed variables only while some are pending", async () => {
    const { api } = card(stage("Production", { configChangedSinceDeploy: true }));
    fireEvent.click(button("Apply changed variables"));
    await waitFor(() => expect(api.redeploy).toHaveBeenCalled());
    cleanup();
    card(stage("Production"));
    expect(screen.queryByRole("button", { name: "Apply changed variables" })).toBeNull();
  });

  it("follows a deployment under way and cancels one that has not started applying", async () => {
    const queued = summary("dpl_next", { status: "queued", version: "1.3.0", finishedAt: null });
    const { api } = card(stage("Production", {}, { latestDeployment: queued }));
    await waitFor(() => expect(screen.getByText("Queued")).toBeTruthy());
    fireEvent.click(button("Cancel deployment"));
    await waitFor(() => expect(api.cancelDeployment).toHaveBeenCalledWith("prj_1", "dpl_next"));
  });

  it("does not offer to cancel a deployment that is being applied", async () => {
    const applying = summary("dpl_next", { status: "applying", finishedAt: null });
    card(stage("Production", {}, { latestDeployment: applying }));
    await waitFor(() => expect(screen.getByText("Applying")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Cancel deployment" })).toBeNull();
  });

  it("marks the deployment that serves, not the newest one", async () => {
    const failed = summary("dpl_next", { status: "failed", version: "1.3.0" });
    card(stage("Production", {}, { latestDeployment: failed }));
    fireEvent.click(button("Deployments"));
    const rows = await waitFor(() => {
      const found = screen.getAllByRole("listitem");
      expect(found).toHaveLength(2);
      return found;
    });
    expect(rows[0].textContent).toContain("1.3.0");
    expect(rows[0].textContent).not.toContain("serving");
    expect(rows[1].textContent).toContain("serving");
  });

  it("says why the newest deployment failed, in Cloud's words", async () => {
    const failed = summary("dpl_next", { status: "failed", errorCode: "rollout_failed" });
    card(stage("Production", {}, { latestDeployment: failed }));
    await waitFor(() => expect(screen.getByText("The new version did not become ready.")).toBeTruthy());
    expect(screen.getByText("rollout_failed")).toBeTruthy();
  });
});
