import { describe, expect, it } from "vitest";
import { fileMapAdapter } from "../run/__tests__/file-map-adapter";
import { workspaceFileRead } from "./workspace-file-read";

describe("workspaceFileRead", () => {
  it("tells text, nothing, a directory and an unreadable file apart", async () => {
    const read = workspaceFileRead(
      fileMapAdapter(
        { "/ws/.env": "A=1\n", "/ws/sub/telo.yaml": "", "/ws/locked": "B=2\n" },
        new Set(["/ws/locked"]),
      ),
    );
    expect(await read("/ws/.env")).toEqual({ kind: "text", text: "A=1\n" });
    expect(await read("/ws/.env.local")).toEqual({ kind: "missing" });
    expect(await read("/ws/gone/.env")).toEqual({ kind: "missing" });
    expect(await read("/ws/sub")).toEqual({ kind: "not-a-file" });
    expect(await read("/ws/locked")).toEqual({
      kind: "unreadable",
      reason: "EACCES: permission denied, open '/ws/locked'",
    });
  });
});
