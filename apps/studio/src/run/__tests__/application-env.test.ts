import { describe, expect, it } from "vitest";
import { envFileProblems, resolveApplicationEnv } from "../application-env";
import { fileMapAdapter } from "./file-map-adapter";

const MANIFEST = "/home/u/ws/apps/shop/telo.yaml";

describe("an Application's env files", () => {
  it("are read up to the workspace marker, the nearest directory winning", async () => {
    const adapter = fileMapAdapter({
      "/home/u/ws/telo-workspace.yaml": "{}\n",
      "/home/u/ws/.env": "PORT=8080\nGREETING=root\n",
      "/home/u/ws/apps/.env.local": "DB_PASSWORD=s3cret\n",
      "/home/u/ws/apps/shop/.env": "GREETING=shop\n",
      [MANIFEST]: "kind: Telo.Application\n",
    });
    const resolution = await resolveApplicationEnv(adapter, "/home/u/ws", MANIFEST);
    expect(resolution.values).toEqual({ PORT: "8080", GREETING: "shop", DB_PASSWORD: "s3cret" });
    expect(resolution.sources.DB_PASSWORD).toBe("/home/u/ws/apps/.env.local");
    expect(envFileProblems(resolution, "/home/u/ws")).toEqual([]);
  });

  it("never find a marker above the opened folder", async () => {
    const adapter = fileMapAdapter({
      "/home/u/telo-workspace.yaml": "{}\n",
      "/home/u/ws/.env": "PORT=8080\n",
      "/home/u/ws/apps/shop/.env": "GREETING=shop\n",
      [MANIFEST]: "",
    });
    const resolution = await resolveApplicationEnv(adapter, "/home/u/ws", MANIFEST);
    expect(resolution.marker).toBeUndefined();
    expect(resolution.values).toEqual({ GREETING: "shop" });
  });

  it("name the marker whose env block is refused, and each file that cannot be read", async () => {
    const broken = fileMapAdapter({
      "/home/u/ws/telo-workspace.yaml": "env:\n  files: [{ name: .env.local, sensitve: true }]\n",
      [MANIFEST]: "",
    });
    const refused = envFileProblems(
      await resolveApplicationEnv(broken, "/home/u/ws", MANIFEST),
      "/home/u/ws",
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.file).toBe("telo-workspace.yaml");
    expect(refused[0]!.reason).toMatch(/sensitve/);

    const locked = fileMapAdapter(
      { "/home/u/ws/apps/shop/.env": "A=1\n", [MANIFEST]: "" },
      new Set(["/home/u/ws/apps/shop/.env"]),
    );
    expect(
      envFileProblems(await resolveApplicationEnv(locked, "/home/u/ws", MANIFEST), "/home/u/ws"),
    ).toEqual([
      {
        file: "apps/shop/.env",
        reason: "EACCES: permission denied, open '/home/u/ws/apps/shop/.env'",
      },
    ]);
  });
});
