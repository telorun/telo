import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CloudApiError, type ProjectPlacementOption } from "../../cloud/api";
import { NewCloudProjectDialog } from "./NewCloudProjectDialog";

const cloud = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../../cloud/context", () => ({ useCloud: () => cloud.value }));

afterEach(() => cleanup());

function place(id: string, isDefault = false): ProjectPlacementOption {
  return { placement: { kind: "target", targetId: id }, name: id, provider: null, isDefault };
}

interface Scene {
  permissions?: string[];
  namespace?: { name: string; host: string } | null;
  placements?: ProjectPlacementOption[];
  createProject?: (project: unknown) => Promise<unknown>;
}

function open(scene: Scene = {}) {
  const api = {
    getRegistryNamespace: vi.fn(async () =>
      scene.namespace === undefined ? { name: "acme", host: "registry.telo.cloud" } : scene.namespace,
    ),
    suggestRegistryNamespace: vi.fn(async () => "acme"),
    claimRegistryNamespace: vi.fn(async (name: string) => ({ name, host: "registry.telo.cloud" })),
    listProjectPlacements: vi.fn(async () => scene.placements ?? [place("Cluster")]),
    createProject: vi.fn(
      scene.createProject ??
        (async () => ({ id: "prj_1", name: "Online Shop", slug: "online-shop", effectiveRole: "admin" })),
    ),
  };
  const openProject = vi.fn(async () => ({ ok: true as const }));
  cloud.value = {
    api,
    openProject,
    session: {
      status: "signedIn",
      identity: {
        user: { id: "usr_1", name: null, email: null },
        org: { id: "org_1" },
        permissions: scene.permissions ?? ["cloud:access", "cloud:projects.create", "cloud:registry.manage"],
        expiresAt: "t",
        consoleUrl: "https://console.telo.cloud",
      },
    },
  };
  const onOpenChange = vi.fn();
  render(<NewCloudProjectDialog open onOpenChange={onOpenChange} />);
  return { api, openProject, onOpenChange };
}

const nameInput = () => screen.getByLabelText("Name") as HTMLInputElement;
const slugInput = () => screen.getByLabelText("Slug") as HTMLInputElement;
const createButton = () => screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;

describe("New Telo Cloud project", () => {
  it("says who can create projects to a session that cannot, and asks Cloud nothing", () => {
    const { api } = open({ permissions: ["cloud:access"] });
    expect(screen.getByText(/does not allow creating projects/)).toBeTruthy();
    expect(api.listProjectPlacements).not.toHaveBeenCalled();
  });

  it("derives the slug from the name until the slug is edited by hand", async () => {
    open();
    await waitFor(() => nameInput());
    fireEvent.change(nameInput(), { target: { value: "Online Shop" } });
    expect(slugInput().value).toBe("online-shop");
    fireEvent.change(slugInput(), { target: { value: "shop" } });
    fireEvent.change(nameInput(), { target: { value: "Online Shop 2" } });
    expect(slugInput().value).toBe("shop");
  });

  it("creates the project on the only place there is and opens it", async () => {
    const { api, openProject, onOpenChange } = open();
    await waitFor(() => nameInput());
    fireEvent.change(nameInput(), { target: { value: "Online Shop" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.createProject).toHaveBeenCalledWith({
      name: "Online Shop",
      slug: "online-shop",
      placement: { kind: "target", targetId: "Cluster" },
    });
    expect(openProject).toHaveBeenCalledWith(expect.objectContaining({ id: "prj_1" }));
  });

  it("starts on the organization's default among several places", async () => {
    const { api } = open({ placements: [place("One"), place("Two", true)] });
    await waitFor(() => nameInput());
    fireEvent.change(nameInput(), { target: { value: "Shop" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(api.createProject).toHaveBeenCalled());
    expect(api.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ placement: { kind: "target", targetId: "Two" } }),
    );
  });

  it("asks for a place when there are several and no default", async () => {
    open({ placements: [place("One"), place("Two")] });
    await waitFor(() => nameInput());
    fireEvent.change(nameInput(), { target: { value: "Shop" } });
    expect(createButton().disabled).toBe(true);
  });

  it("creates a project without a stage where there is no hosting, and says so first", async () => {
    const { api } = open({ placements: [] });
    await waitFor(() => nameInput());
    expect(screen.getByText(/created without\s+a stage/)).toBeTruthy();
    fireEvent.change(nameInput(), { target: { value: "Shop" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: "Shop", slug: "shop" }));
  });

  it("has the organization's namespace claimed before its first project", async () => {
    const { api } = open({ namespace: null });
    const input = (await waitFor(() => screen.getByLabelText("Registry namespace"))) as HTMLInputElement;
    // The form starts from the name Cloud suggests.
    expect(input.value).toBe("acme");
    expect(screen.getByText(/It is permanent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Claim namespace" }));
    await waitFor(() => nameInput());
    expect(api.claimRegistryNamespace).toHaveBeenCalledWith("acme");
  });

  it("tells who claims the namespace to someone who cannot", async () => {
    open({ namespace: null, permissions: ["cloud:access", "cloud:projects.create"] });
    await waitFor(() => expect(screen.getByText(/An owner or admin claims it/)).toBeTruthy());
    expect(screen.queryByLabelText("Registry namespace")).toBeNull();
  });

  it("shows a refusal in words and keeps the form", async () => {
    const { onOpenChange } = open({
      createProject: async () => {
        throw new CloudApiError(409, "slug_unavailable", {});
      },
    });
    await waitFor(() => nameInput());
    fireEvent.change(nameInput(), { target: { value: "Shop" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(screen.getByText(/already has that slug/)).toBeTruthy());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(nameInput().value).toBe("Shop");
  });
});
