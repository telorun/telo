import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inside a release workspace an import leaving the importer's directory is
 * written as its target's ASSIGNED destination, whatever depth and registry base
 * each module sits at; outside one it is derived from the importer's path.
 *
 * The registry read publish verifies sibling pins with is stubbed at the module
 * boundary, as `verify-import-pins.test.ts` does.
 */
const fetchManifestHash = vi.fn<(ref: string) => Promise<string>>();
vi.mock("../src/manifest-hash.js", () => ({
  fetchManifestHash: (ref: string) => fetchManifestHash(ref),
}));

const { publish, publishPayloadBuilder, verifySiblingPinsForTest } = await import(
  "../src/commands/publish.js"
);
const { createLogger } = await import("../src/logger.js");
const { Output, installOutput } = await import("../src/output.js");
const { digestPayload } = await import("../src/release/evidence.js");
const { writeLedger } = await import("../src/release/ledger-store.js");
const { workspaceAssignment } = await import("../src/release/targets.js");
const { loadWorkspace } = await import("../src/release/workspace.js");
const { planWorkspace } = await import("../src/release/workspace-plan.js");

const REGISTRY = "oci://registry.example/acme";
const BLUEPRINTS = `${REGISTRY}/blueprints`;
const APP_DESTINATION = `${BLUEPRINTS}/app`;

let root: string;

function write(relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const library = (name: string, version: string, imports: Record<string, string> = {}) =>
  [
    "kind: Telo.Library",
    "metadata:",
    `  name: ${name}`,
    `  version: ${version}`,
    ...(Object.keys(imports).length > 0
      ? ["imports:", ...Object.entries(imports).map(([alias, source]) => `  ${alias}: ${source}`)]
      : []),
    "",
  ].join("\n");

const pin = (text: string): string =>
  `sha256-${createHash("sha256").update(text).digest("base64url")}`;

/** A library under `modules/` and a blueprint under its own registry base, one
 *  level deeper, importing it — the layout path arithmetic gets wrong. */
function writeWorkspace(): { lib: string; app: string } {
  write(
    "telo-workspace.yaml",
    `release:\n  registry: ${REGISTRY}\n  modules:\n    - modules/*\n    - path: blueprints/*\n      registry: ${BLUEPRINTS}\n`,
  );
  return {
    lib: write("modules/lib/telo.yaml", library("Lib", "1.0.0")),
    app: write("blueprints/app/telo.yaml", library("App", "0.1.0", { Lib: "../../modules/lib" })),
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-assigned-destinations-")));
  fetchManifestHash.mockReset();
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("a module of a release workspace", () => {
  it("publishes an import of a module at another depth and base as that module's assigned ref", async () => {
    const { lib, app } = writeWorkspace();
    const assignment = workspaceAssignment(app, {});
    expect(assignment?.destination).toBe(APP_DESTINATION);

    const builder = publishPayloadBuilder(app, assignment);
    const payload = await builder.payload(app, APP_DESTINATION);
    const libPin = pin(await builder.publishedManifest(lib));

    expect(payload.manifest).toContain(`Lib: ${REGISTRY}/lib@1.0.0#${libPin}`);
    expect(payload.relativeImports).toEqual([
      { alias: "Lib", manifestPath: lib, ref: `${REGISTRY}/lib@1.0.0`, integrity: libPin },
    ]);
  });

  it("plans a relative import of a manifest the workspace does not release as an error", async () => {
    writeWorkspace();
    write("modules/lib/inner/telo.yaml", library("Inner", "1.0.0"));
    write("blueprints/app/telo.yaml", library("App", "0.1.0", { Inner: "../../modules/lib/inner" }));

    const { plan } = await planWorkspace(loadWorkspace(root), { rungs: {}, baseRef: "HEAD" });

    expect(plan.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "IMPORT_TARGET_NOT_RELEASED",
        message: expect.stringContaining(
          "blueprints/app imports 'modules/lib/inner/telo.yaml' by relative path",
        ),
      }),
    ]);
    expect(plan.diagnostics[0]!.message).toContain("it lies inside modules/lib");
  });

  it("refuses a positional destination the workspace does not assign it", async () => {
    const { app } = writeWorkspace();
    const stdout = { text: "", write: (chunk: string) => (stdout.text += chunk) };
    const restore = installOutput(
      new Output({ format: "json", stdout, stderr: { write: () => {} }, env: {} }),
    );
    try {
      await publish({
        paths: [`${REGISTRY}/app`, app],
        dryRun: true,
        skipControllers: true,
      });
    } finally {
      restore();
      process.exitCode = undefined;
    }

    expect(JSON.parse(stdout.text).modules[0].error).toMatchObject({
      code: "destination_mismatch",
      details: { module: "blueprints/app", given: `${REGISTRY}/app`, assigned: APP_DESTINATION },
    });
  });

  it("refuses a push whose sibling is served with other bytes under the same version", async () => {
    const { app } = writeWorkspace();
    const payload = await publishPayloadBuilder(app, workspaceAssignment(app, {})).payload(
      app,
      APP_DESTINATION,
    );
    fetchManifestHash.mockResolvedValueOnce(pin("kind: Telo.Library\n"));

    await expect(verifySiblingPinsForTest(payload, createLogger(false))).rejects.toMatchObject({
      code: "import_pin_mismatch",
      details: { alias: "Lib", ref: `${REGISTRY}/lib@1.0.0` },
    });
    expect(fetchManifestHash).toHaveBeenCalledWith(`${REGISTRY}/lib@1.0.0`);
  });

  it("plans no drift once the payloads publish computes are recorded", async () => {
    const { lib, app } = writeWorkspace();
    const entries = new Map();
    for (const [key, manifest, registry] of [
      ["modules/lib", lib, REGISTRY],
      ["blueprints/app", app, BLUEPRINTS],
    ] as const) {
      const assignment = workspaceAssignment(manifest, {})!;
      const payload = await publishPayloadBuilder(manifest, assignment).payload(
        manifest,
        assignment.destination!,
      );
      entries.set(key, {
        version: assignment.module.version,
        registry,
        layers: await digestPayload(payload),
      });
    }
    writeLedger(root, { modules: entries });

    const { plan } = await planWorkspace(loadWorkspace(root), { rungs: {}, baseRef: "HEAD" });

    expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(plan.modules).toEqual([]);
  });
});

describe("a publish inside a workspace with unresolved destinations elsewhere", () => {
  const withoutRegistry = (modules: string[]) =>
    `release:\n  modules:\n${modules.join("")}`;

  async function publishDryRun(destination: string, manifest: string) {
    const stdout = { text: "", write: (chunk: string) => (stdout.text += chunk) };
    const stderr = { text: "", write: (chunk: string) => (stderr.text += chunk) };
    const restore = installOutput(new Output({ format: "json", stdout, stderr, env: {} }));
    try {
      await publish({ paths: [destination, manifest], dryRun: true, skipControllers: true });
    } finally {
      restore();
      process.exitCode = undefined;
    }
    return { report: JSON.parse(stdout.text).modules[0], stderr: stderr.text };
  }

  beforeEach(() => {
    delete process.env.TELO_OCI_REGISTRY;
  });

  it("ignores an unrelated module with no destination", async () => {
    write(
      "telo-workspace.yaml",
      `release:\n  modules:\n    - path: mods/*\n      registry: ${REGISTRY}\n    - other/*\n`,
    );
    const a = write("mods/a/telo.yaml", library("A", "1.0.0"));
    write("other/b/telo.yaml", library("B", "1.0.0"));

    const { report, stderr } = await publishDryRun(`${REGISTRY}/a`, a);

    // Past the destination gate: it stops at the unreachable stub registry.
    expect(report.error.code).toBe("registry_unavailable");
    expect(stderr).not.toContain("NO_DESTINATION_KNOWN");
  });

  it("refuses a module with no destination of its own, without naming --registry as a publish option", async () => {
    write("telo-workspace.yaml", withoutRegistry(["    - other/*\n"]));
    const b = write("other/b/telo.yaml", library("B", "1.0.0"));

    const { report } = await publishDryRun(`${REGISTRY}/b`, b);

    expect(report.error.code).toBe("publish_failed");
    expect(report.error.message).toContain("other/b has no publish destination");
    expect(report.error.message).toContain("TELO_OCI_REGISTRY");
    expect(report.error.message).not.toContain("pass --registry");
  });

  it("refuses when a sibling it imports has no destination", async () => {
    write(
      "telo-workspace.yaml",
      `release:\n  modules:\n    - path: mods/*\n      registry: ${REGISTRY}\n    - other/*\n`,
    );
    const a = write("mods/a/telo.yaml", library("A", "1.0.0", { B: "../../other/b" }));
    write("other/b/telo.yaml", library("B", "1.0.0"));

    const { report } = await publishDryRun(`${REGISTRY}/a`, a);

    expect(report.error.code).toBe("publish_failed");
    expect(report.error.message).toContain("other/b has no publish destination");
  });

  it("refuses when the marker cannot be read", async () => {
    write("telo-workspace.yaml", "release:\n  registry: [unclosed\n");
    const a = write("mods/a/telo.yaml", library("A", "1.0.0"));

    await expect(publishDryRun(`${REGISTRY}/a`, a)).rejects.toThrow();
  });
});

describe("a module outside any release workspace", () => {
  it("canonicalizes a sibling by its path, and refuses a push while that sibling is unpublished", async () => {
    write("modules/lib/telo.yaml", library("Lib", "1.0.0"));
    const app = write(
      "blueprints/app/telo.yaml",
      library("App", "0.1.0", { Lib: "../../modules/lib" }),
    );
    const assignment = workspaceAssignment(app, {});
    expect(assignment).toBeNull();

    const payload = await publishPayloadBuilder(app, assignment).payload(app, APP_DESTINATION);
    fetchManifestHash.mockRejectedValueOnce(new Error("manifest unknown"));

    await expect(verifySiblingPinsForTest(payload, createLogger(false))).rejects.toMatchObject({
      code: "sibling_not_published",
      details: { refs: [`${REGISTRY}/modules/lib@1.0.0`] },
    });
  });
});
