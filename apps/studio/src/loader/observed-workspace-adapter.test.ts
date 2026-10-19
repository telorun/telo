import { describe, expect, it } from "vitest";
import { fileMapAdapter } from "../run/__tests__/file-map-adapter";
import { ObservedWorkspaceAdapter, type WorkspaceChange } from "./observed-workspace-adapter";

describe("ObservedWorkspaceAdapter", () => {
  it("publishes the paths every write, delete and rename touched", async () => {
    const published: WorkspaceChange[] = [];
    const adapter = new ObservedWorkspaceAdapter(fileMapAdapter({ "/ws/a": "" }), (change) =>
      published.push(change),
    );
    await adapter.writeFile("/ws/b", "x");
    await adapter.rename("/ws/b", "/ws/c");
    await adapter.delete("/ws/a");
    await adapter.readFile("/ws/c");
    expect(published).toEqual([
      { kind: "paths", paths: ["/ws/b"] },
      { kind: "paths", paths: ["/ws/b", "/ws/c"] },
      { kind: "paths", paths: ["/ws/a"] },
    ]);
  });
});
