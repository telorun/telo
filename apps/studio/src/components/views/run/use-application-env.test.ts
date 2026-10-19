import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createWorkspaceChanges } from "../../../loader/observed-workspace-adapter";
import { fileMapAdapter } from "../../../run/__tests__/file-map-adapter";
import { useApplicationEnv } from "./use-application-env";

const MANIFEST = "/ws/apps/shop/telo.yaml";

describe("the Variables tab's reading of the env files", () => {
  it("is read again on a change to an env file in force, the marker or the whole workspace", async () => {
    const adapter = fileMapAdapter({ "/ws/apps/shop/.env": "GREETING=one\n", [MANIFEST]: "" });
    const changes = createWorkspaceChanges();
    const environment = { rootDir: "/ws", adapter: () => adapter, changes };
    const { result } = renderHook(() => useApplicationEnv(MANIFEST, environment));
    await waitFor(() => expect(result.current.resolution?.values.GREETING).toBe("one"));

    adapter.files.set("/ws/apps/shop/.env", "GREETING=two\n");
    act(() => changes.publish({ kind: "paths", paths: ["/ws/apps/shop/notes.md"] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.resolution?.values.GREETING).toBe("one");

    act(() => changes.publish({ kind: "paths", paths: ["/ws/apps/shop/.env"] }));
    await waitFor(() => expect(result.current.resolution?.values.GREETING).toBe("two"));

    adapter.files.set("/ws/apps/shop/.env.local", "GREETING=three\n");
    act(() => changes.publish({ kind: "workspace" }));
    await waitFor(() => expect(result.current.resolution?.values.GREETING).toBe("three"));
  });
});
