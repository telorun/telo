import { describe, expect, it } from "vitest";
import type { NeedTableEntry } from "../src/need-table.js";
import { sensitiveEnvironmentInputs } from "../src/sensitive-environment-inputs.js";
import { resolveWorkspaceEnv, type EnvFileRead } from "../src/workspace-env/env-file-resolution.js";
import {
  classifySensitiveEnvFiles,
  describeSensitiveValueFinding,
  envFileDestination,
  sensitiveValueFindings,
} from "../src/workspace-env/env-file-sensitivity.js";

type Entry = string | { dir: true } | { unreadable: string };

/** A read over an in-memory tree: a string is a file, anything else what the
 *  host would answer for that path. */
const tree = (files: Record<string, Entry>) => async (path: string): Promise<EnvFileRead> => {
  const entry = files[path];
  if (entry === undefined) return { kind: "missing" };
  if (typeof entry === "string") return { kind: "text", text: entry };
  return "dir" in entry ? { kind: "not-a-file" } : { kind: "unreadable", reason: entry.unreadable };
};

describe("resolving a workspace's env files", () => {
  it("records each value's file and each file's sensitive mark, on any root spelling", async () => {
    const read = tree({
      "C:/repo/telo-workspace.yaml": "env:\n  files: [.env, { name: .secrets, sensitive: true }]\n",
      "C:/repo/.env": "A=root\nB=root\n",
      "C:/repo/app/.secrets": "B=near\n",
    });
    const resolved = await resolveWorkspaceEnv({ start: "C:/repo/app", read });
    expect(resolved.values).toEqual({ A: "root", B: "near" });
    expect(resolved.sources).toEqual({ A: "C:/repo/.env", B: "C:/repo/app/.secrets" });
    expect(resolved.files).toEqual([
      { path: "C:/repo/.env", sensitive: false },
      { path: "C:/repo/app/.secrets", sensitive: true },
    ]);
    expect(resolved.marker).toBe("C:/repo/telo-workspace.yaml");
  });

  it("looks for the marker no higher than the ceiling, collapsing to the start without one", async () => {
    const read = tree({
      "/home/u/telo-workspace.yaml": "",
      "/home/u/.env.local": "LEAK=1\n",
      "/home/u/project/.env": "OWN=1\n",
      "/home/u/project/app/.env": "APP=1\n",
    });
    const resolved = await resolveWorkspaceEnv({ start: "/home/u/project/app", ceiling: "/home/u/project", read });
    expect(resolved.values).toEqual({ APP: "1" });
    expect(resolved.marker).toBeUndefined();
    await expect(resolveWorkspaceEnv({ start: "/elsewhere", ceiling: "/home/u/project", read })).rejects.toThrow(
      /outside its ceiling/,
    );
  });

  it("refuses on a marker it finds and cannot read, and skips a directory of that name", async () => {
    const unreadable = await resolveWorkspaceEnv({
      start: "/repo/app",
      read: tree({ "/repo/telo-workspace.yaml": { unreadable: "EACCES" }, "/repo/app/.env": "A=1\n" }),
    });
    expect(unreadable.failed).toMatch(/\/repo\/telo-workspace\.yaml could not be read \(EACCES\)/);
    expect(unreadable.values).toEqual({});

    const directory = await resolveWorkspaceEnv({
      start: "/repo/app",
      read: tree({ "/repo/app/telo-workspace.yaml": { dir: true }, "/repo/telo-workspace.yaml": "", "/repo/.env": "A=1\n" }),
    });
    expect(directory.marker).toBe("/repo/telo-workspace.yaml");
    expect(directory.values).toEqual({ A: "1" });
  });
});

describe("which env files are sensitive", () => {
  it("reads each file's nearest marker, the default where none governs", async () => {
    const paths = [
      ".env.local",
      "telo-workspace.yaml",
      "apps/.env.local",
      "apps/.secrets",
      "vendor/telo-workspace.yaml",
      "vendor/x/.env.local",
      "vendor/x/.secrets",
    ];
    const read = tree({
      "telo-workspace.yaml": "env:\n  files: [.env, { name: .secrets, sensitive: true }]\n",
      "vendor/telo-workspace.yaml": "# anchor\n",
    });
    // The root marker names `.secrets`; the nested one declares no files, so
    // the default applies beneath it.
    expect(await classifySensitiveEnvFiles(paths, read)).toEqual({
      sensitive: new Set(["apps/.secrets", "vendor/x/.env.local"]),
    });
    expect(await classifySensitiveEnvFiles(["a/.env.local", "a/.env"], read)).toEqual({
      sensitive: new Set(["a/.env.local"]),
    });
  });

  it("refuses when a marker's env: has an error", async () => {
    const read = tree({ "telo-workspace.yaml": "env:\n  files: [{ name: .env.local, sensitve: true }]\n" });
    expect(await classifySensitiveEnvFiles(["telo-workspace.yaml", ".env.local"], read)).toEqual({
      failed: expect.stringContaining("Did you mean 'sensitive'?"),
    });
  });

  it("writes a value to the last entry of its kind, or says what to declare", () => {
    const entries = [
      { name: ".env", sensitive: false },
      { name: ".a", sensitive: true },
      { name: ".env.shared", sensitive: false },
      { name: ".b", sensitive: true },
    ];
    expect(envFileDestination(entries, true)).toEqual({ name: ".b" });
    expect(envFileDestination(entries, false)).toEqual({ name: ".env.shared" });
    expect(envFileDestination([{ name: ".env", sensitive: false }], true)).toEqual({
      refused: expect.stringContaining("env.files in telo-workspace.yaml marks no file sensitive"),
    });
  });
});

describe("a sensitive value read from a file without the mark", () => {
  const root = {
    kind: "Telo.Application",
    metadata: { name: "App" },
    variables: { region: { type: "string", env: "REGION" } },
    secrets: { dbPassword: { type: "string", env: "DB_PASSWORD" }, argOnly: { type: "string" } },
  };
  const need = {
    path: ["databaseAccess"],
    fields: {
      url: { env: "TELO_NEED_DATABASE_ACCESS__URL", envSource: "derived", required: true, sensitive: true },
      schema: { env: "TELO_NEED_DATABASE_ACCESS__SCHEMA", envSource: "derived", required: false, sensitive: false },
    },
  } as unknown as NeedTableEntry;

  it("is every env-bound secret and every need field the table marks sensitive", () => {
    expect(sensitiveEnvironmentInputs(root, [need])).toEqual([
      { env: "DB_PASSWORD", source: "secret", name: "dbPassword" },
      { env: "TELO_NEED_DATABASE_ACCESS__URL", source: "sensitive need field", name: "databaseAccess.url" },
    ]);
  });

  it("is found only where the value was applied from a file not marked sensitive", async () => {
    const resolution = await resolveWorkspaceEnv({
      start: "/repo",
      read: tree({
        "/repo/.env": "DB_PASSWORD=x\nREGION=eu\nTELO_NEED_DATABASE_ACCESS__URL=postgres://h\n",
        "/repo/.env.local": "TELO_NEED_DATABASE_ACCESS__URL=postgres://local\n",
      }),
    });
    const inputs = sensitiveEnvironmentInputs(root, [need]);
    const findings = sensitiveValueFindings(resolution, ["DB_PASSWORD", "REGION", "TELO_NEED_DATABASE_ACCESS__URL"], inputs);
    expect(findings.map((finding) => describeSensitiveValueFinding(finding, "./.env"))).toEqual([
      "secret DB_PASSWORD is set in ./.env, which env.files does not mark sensitive — move it to a sensitive file",
    ]);
    // The real environment already held it, so the file's value was never read.
    expect(sensitiveValueFindings(resolution, ["REGION"], inputs)).toEqual([]);
  });
});
