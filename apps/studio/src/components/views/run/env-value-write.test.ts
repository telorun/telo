import { describe, expect, it } from "vitest";
import { resolveApplicationEnv } from "../../../run/application-env";
import { fileMapAdapter } from "../../../run/__tests__/file-map-adapter";
import { writeEnvValue } from "./env-value-write";

const ROOT = "/ws";
const MANIFEST = "/ws/apps/shop/telo.yaml";

async function write(adapter: ReturnType<typeof fileMapAdapter>, key: string, value: string, sensitive: boolean) {
  const resolution = await resolveApplicationEnv(adapter, ROOT, MANIFEST);
  await writeEnvValue({ adapter, resolution, manifestPath: MANIFEST, key, value, sensitive });
}

describe("writing a value into the env files", () => {
  it("rewrites only its own line in the file the value comes from", async () => {
    const adapter = fileMapAdapter({
      "/ws/telo-workspace.yaml": "{}\n",
      "/ws/.env": "# shared\nGREETING=hello # greeting\nPORT=8080\n",
      [MANIFEST]: "",
    });
    await write(adapter, "GREETING", "hi there", false);
    expect(adapter.files.get("/ws/.env")).toBe("# shared\nGREETING='hi there' # greeting\nPORT=8080\n");
  });

  it("adds an unset secret to the sensitive file beside the manifest, and an unset variable to the other", async () => {
    const adapter = fileMapAdapter({ "/ws/apps/shop/.env": "PORT=8080", [MANIFEST]: "" });
    await write(adapter, "DB_PASSWORD", "s3cret", true);
    await write(adapter, "GREETING", "hi", false);
    expect(adapter.files.get("/ws/apps/shop/.env.local")).toBe("DB_PASSWORD=s3cret\n");
    expect(adapter.files.get("/ws/apps/shop/.env")).toBe("PORT=8080\nGREETING=hi\n");
  });

  it("removes the value's line when it is cleared", async () => {
    const adapter = fileMapAdapter({
      "/ws/telo-workspace.yaml": "{}\n",
      "/ws/.env": "A=1\nGREETING=hello\nB=2\n",
      [MANIFEST]: "",
    });
    await write(adapter, "GREETING", "", false);
    expect(adapter.files.get("/ws/.env")).toBe("A=1\nB=2\n");
  });

  it("writes nothing for a secret when env.files marks no file sensitive", async () => {
    const adapter = fileMapAdapter({
      "/ws/telo-workspace.yaml": "env:\n  files: [.env]\n",
      [MANIFEST]: "",
    });
    await expect(write(adapter, "DB_PASSWORD", "s3cret", true)).rejects.toThrow(/env\.files/);
    expect([...adapter.files.keys()].sort()).toEqual(["/ws/apps/shop/telo.yaml", "/ws/telo-workspace.yaml"]);
  });
});
