import { describe, expect, it } from "vitest";
import { applicationSensitiveInputs, resolveApplicationEnv } from "../../../run/application-env";
import { fileMapAdapter } from "../../../run/__tests__/file-map-adapter";
import type { ApplicationManifest } from "../../../model";
import { envRowFacts } from "./env-row-facts";

const MANIFEST: ApplicationManifest = {
  kind: "Application",
  filePath: "/ws/apps/shop/telo.yaml",
  metadata: { name: "Shop" },
  imports: [],
  resources: [],
  targets: [],
  secrets: { dbPassword: { env: "DB_PASSWORD", type: "string" } },
};

async function factsOver(files: Record<string, string>) {
  const adapter = fileMapAdapter(files);
  return envRowFacts({
    resolution: await resolveApplicationEnv(adapter, "/ws", MANIFEST.filePath),
    rootDir: "/ws",
    manifestPath: MANIFEST.filePath,
    sensitiveInputs: applicationSensitiveInputs(MANIFEST),
    adapter: () => adapter,
    readOnly: false,
  });
}

describe("a Variables row", () => {
  it("shows the file a secret comes from, with the run's warning when the file is not sensitive", async () => {
    const facts = await factsOver({ "/ws/apps/shop/.env": "DB_PASSWORD=s3cret\n" });
    expect(facts("DB_PASSWORD")).toMatchObject({
      value: "s3cret",
      source: "apps/shop/.env",
      warning:
        "secret DB_PASSWORD is set in apps/shop/.env, which env.files does not mark sensitive — move it to a sensitive file",
    });
    expect((await factsOver({ "/ws/apps/shop/.env.local": "DB_PASSWORD=s3cret\n" }))("DB_PASSWORD").warning).toBeUndefined();
  });

  it("says why an unset secret cannot be written when no env file is sensitive", async () => {
    const facts = await factsOver({ "/ws/apps/shop/telo-workspace.yaml": "env:\n  files: [.env]\n" });
    expect(facts("DB_PASSWORD").unwritable).toMatch(/env\.files/);
  });
});
