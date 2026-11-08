import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import semver from "semver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkspaceRequires } from "../src/release/check-requires.js";
import {
  FloorMeasurementError,
  FloorProbe,
  RegistryUnreachableError,
  listPublishedFinals,
  mentions,
  type CliRunner,
} from "../src/release/floor-measurement.js";
import { floorLine, measureAndWriteFloors } from "../src/release/floor-workspace.js";
import { verifyFloor } from "../src/release/verify-requires.js";
import { loadWorkspace } from "../src/release/workspace.js";

const FINALS = Array.from({ length: 14 }, (_, i) => `0.${77 + i}.0`); // 0.77.0 .. 0.90.0

let root: string;
let calls: Array<{ version: string; paths: string[] }>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-floors-"));
  calls = [];
  fs.writeFileSync(path.join(root, "telo-workspace.yaml"), "release:\n  modules:\n    - modules/*\n");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * One module: `needs` is what the fake CLI needs of a release to read it (a
 * version, or `unreleased`), `floor` what it declares, `imports` a sibling.
 */
function writeModule(
  name: string,
  options: { needs?: string; floor?: string; imports?: string } = {},
): string {
  const lines = [
    "kind: Telo.Library",
    "metadata:",
    `  name: ${name}`,
    "  version: 1.0.0",
    ...(options.needs ? [`  # needs: ${options.needs}`] : []),
    ...(options.floor ? [`requires: { telo: "${options.floor}" }`] : []),
    ...(options.imports ? ["imports:", `  Sibling: ../${options.imports}`] : []),
    "exports:",
    "  kinds: []",
    "",
  ];
  const file = path.join(root, "modules", name, "telo.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

/** The module's declared floor in a manifest text. */
function floorIn(text: string): string | undefined {
  return /^requires: \{ telo: "?>=([^"\s]+)/m.exec(text)?.[1];
}

/** Why the fake CLI at `version` rejects the manifest, if it does. */
function rejection(version: string, file: string): string | undefined {
  const text = fs.readFileSync(file, "utf8");
  const floor = floorIn(text);
  if (floor && floor !== "unreleased" && semver.lt(version, floor)) return "MODULE_REQUIRES_NEWER_RUNTIME";
  const needs = /# needs: (\S+)/.exec(text)?.[1];
  if (needs && (needs === "unreleased" || semver.lt(version, needs))) return "SPAN_ATTRIBUTE_MISPLACED";
  return undefined;
}

/** A `telo check` that rejects exactly what `rejection` says, on line 25. */
function fakeCli(): CliRunner {
  return async (version, paths) => {
    calls.push({ version, paths });
    const lines = paths.flatMap((file) => {
      const code = rejection(version, file);
      return code ? [`${file}:25:1  error  nope  ${code}`] : [];
    });
    return lines.length > 0
      ? { status: "failed", output: `${lines.join("\n")}\n\n${lines.length} errors` }
      : { status: "passed" };
  };
}

const manifest = (name: string): string => fs.readFileSync(path.join(root, "modules", name, "telo.yaml"), "utf8");

describe("telo release floor", () => {
  it("writes each measured floor, siblings first, and reports it as the plan prints it", async () => {
    writeModule("geocode", { needs: "unreleased" });
    writeModule("geocode-cache", { floor: ">=0.80.0", imports: "geocode" });
    writeModule("kv-store", { needs: "0.82.0", floor: ">=0.82.0" });
    writeModule("console", { floor: ">=0.80.0" });

    const results = await measureAndWriteFloors(loadWorkspace(root), loadWorkspace(root).modules, {
      runner: fakeCli(),
      finals: FINALS,
    });

    expect(results.map(floorLine)).toEqual([
      // The copy gained a one-line requires block, so the CLI's line 25 is line 24 here.
      "modules/console: >=0.80.0 → (none) (accepted by 0.77.0, the oldest telo that reads requires:)",
      "modules/geocode: (none) → >=unreleased (no published telo accepts it; 0.90.0 reports SPAN_ATTRIBUTE_MISPLACED at telo.yaml:24)",
      "modules/geocode-cache: >=0.80.0 → >=unreleased (imports modules/geocode at >=unreleased)",
      "modules/kv-store: >=0.82.0 unchanged",
    ]);
    expect(floorIn(manifest("geocode"))).toBe("unreleased");
    expect(floorIn(manifest("geocode-cache"))).toBe("unreleased");
    expect(manifest("console")).not.toContain("requires:");
    expect(fs.existsSync(path.join(root, "modules", "geocode", ".telo-floor-measure.yaml"))).toBe(false);
  });

  it("measures the lowest accepting release, sharing one run among modules probing the same one", async () => {
    writeModule("a", { needs: "0.85.0" });
    writeModule("b", { needs: "0.85.0" });
    const workspace = loadWorkspace(root);

    const results = await measureAndWriteFloors(workspace, workspace.modules, {
      runner: fakeCli(),
      finals: FINALS,
    });

    expect(results.map((r) => r.to)).toEqual([
      { kind: "version", version: "0.85.0" },
      { kind: "version", version: "0.85.0" },
    ]);
    expect(calls.every((call) => call.paths.length === 2)).toBe(true);
  });

  it("restores every file it wrote when a later module cannot be measured", async () => {
    writeModule("geocode", { needs: "0.85.0" });
    writeModule("geocode-cache", { imports: "geocode" });
    const before = manifest("geocode");
    const workspace = loadWorkspace(root);
    const inner = fakeCli();
    const runner: CliRunner = async (version, paths) =>
      paths.some((p) => p.includes("geocode-cache"))
        ? { status: "failed", output: "something unrelated broke" }
        : inner(version, paths);

    await expect(
      measureAndWriteFloors(workspace, workspace.modules, { runner, finals: FINALS }),
    ).rejects.toBeInstanceOf(FloorMeasurementError);
    expect(manifest("geocode")).toBe(before);
  });

  it("refuses a module whose requires.telo declares an upper bound", async () => {
    writeModule("geocode", { floor: ">=0.80.0 <0.85.0" });
    const workspace = loadWorkspace(root);
    await expect(
      measureAndWriteFloors(workspace, workspace.modules, { runner: fakeCli(), finals: FINALS }),
    ).rejects.toThrow(/upper bound.*restrictions: entry/s);
  });

  it("fails with the registry and its reason when the versions cannot be listed", async () => {
    const failing = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch;
    await expect(listPublishedFinals(failing, "https://registry.npmjs.org")).rejects.toThrow(
      new RegistryUnreachableError(
        "https://registry.npmjs.org/@telorun%2fcli",
        "ENOTFOUND",
      ),
    );
  });

  it("lists published finals from the oldest release that reads requires:", async () => {
    const registry = (async () =>
      new Response(
        JSON.stringify({
          versions: { "0.76.0": {}, "0.77.0": {}, "0.78.0-rc.1": {}, "0.121.0": {}, "0.78.0": {} },
        }),
      )) as unknown as typeof fetch;
    expect(await listPublishedFinals(registry)).toEqual(["0.77.0", "0.78.0", "0.121.0"]);
  });
});

describe("telo release check — floors", () => {
  const check = (currentVersion = "0.90.0") =>
    checkWorkspaceRequires(loadWorkspace(root), { currentVersion, runner: fakeCli(), finals: FINALS });

  it("passes a measured floor, a floor-less module V0 accepts and a waiting >=unreleased", async () => {
    writeModule("exact", { needs: "0.82.0", floor: ">=0.82.0" });
    writeModule("none");
    writeModule("waiting", { needs: "unreleased", floor: ">=unreleased" });
    const result = await check();
    expect(result.failures).toEqual([]);
    expect(result.checks.map((c) => [c.floor, c.modules])).toEqual([
      ["(none)", ["modules/none"]],
      [">=0.82.0", ["modules/exact"]],
      [">=unreleased", ["modules/waiting"]],
    ]);
  });

  it("costs two runs per distinct floor, however many modules declare it", async () => {
    writeModule("a", { needs: "0.82.0", floor: ">=0.82.0" });
    writeModule("b", { needs: "0.82.0", floor: ">=0.82.0" });
    await check();
    expect(calls.map((c) => [c.version, c.paths.length])).toEqual([
      ["0.82.0", 2],
      ["0.81.0", 2],
    ]);
  });

  it("fails a floor below the measured one, naming what the CLI at it reports and the measured value", async () => {
    writeModule("low", { needs: "0.85.0", floor: ">=0.80.0" });
    const [failure] = (await check()).failures;
    expect(failure).toMatchObject({ module: "modules/low", code: "REQUIRES_FLOOR_TOO_LOW", measured: ">=0.85.0" });
    expect(failure!.message).toBe(
      "requires.telo is '>=0.80.0'; telo 0.80.0 reports SPAN_ATTRIBUTE_MISPLACED at telo.yaml:25, " +
        "and the lowest published telo that accepts this module is 0.85.0. " +
        "Run `telo release floor --module modules/low`.",
    );
  });

  it("fails a missing floor when the oldest telo that reads requires: rejects the module", async () => {
    writeModule("missing", { needs: "0.79.0" });
    const [failure] = (await check()).failures;
    expect(failure!.code).toBe("REQUIRES_FLOOR_TOO_LOW");
    expect(failure!.message).toMatch(/^requires\.telo is missing; telo 0\.77\.0 reports SPAN_ATTRIBUTE_MISPLACED/);
  });

  it("fails a floor raised by hand, a floor at or below the oldest telo that reads requires:, and an unpublished number", async () => {
    writeModule("raised", { needs: "0.85.0", floor: ">=0.88.0" });
    writeModule("ancient", { floor: ">=0.70.0" });
    writeModule("future", { floor: ">=0.95.0" });
    const failures = (await check()).failures;
    expect(failures.map((f) => [f.module, f.code, f.measured])).toEqual([
      ["modules/ancient", "REQUIRES_FLOOR_TOO_HIGH", "(none)"],
      ["modules/raised", "REQUIRES_FLOOR_TOO_HIGH", ">=0.85.0"],
      ["modules/future", "REQUIRES_FLOOR_TOO_HIGH", "(none)"],
    ]);
    expect(failures.find((f) => f.module === "modules/future")!.message).toContain(
      "no published telo is 0.95.0 (the latest is 0.90.0)",
    );
  });

  it("fails a >=unreleased a published release now accepts, naming that release", async () => {
    writeModule("stale", { needs: "0.85.0", floor: ">=unreleased" });
    const [failure] = (await check()).failures;
    expect(failure!.message).toBe(
      "requires.telo is '>=unreleased'; published telo 0.85.0 accepts this module. " +
        "Run `telo release floor --module modules/stale`.",
    );
  });

  it("accepts the line version the version step just wrote, though npm does not have it yet", async () => {
    writeModule("fresh", { needs: "0.91.0", floor: ">=0.91.0" });
    expect((await check("0.91.0")).failures).toEqual([]);
  });
});

describe("telo publish — the floor preflight", () => {
  const text = (floor: string): string => `kind: Telo.Library\nmetadata:\n  name: A\n  version: 1.0.0\nrequires:\n  telo: "${floor}"\n`;

  it("waits on a floor newer than anything published, fails a false one and passes a true one", async () => {
    const file = path.join(root, "telo.yaml");
    fs.writeFileSync(file, "");
    const runner: CliRunner = async (version) =>
      semver.lt(version, "0.85.0")
        ? { status: "failed", output: `${file.replace("telo.yaml", ".telo-floor-measure.yaml")}:5:3  error  x  SCHEMA_VIOLATION` }
        : { status: "passed" };
    const verify = (floor: string) =>
      verifyFloor(file, text(floor), { currentVersion: "0.90.0", publishedVersions: FINALS, runner });

    expect(await verify(">=0.95.0")).toMatchObject({ status: "pending", latestPublished: "0.90.0" });
    expect(await verify(">=0.80.0")).toMatchObject({ status: "failed", reading: "0.80.0 reports SCHEMA_VIOLATION at telo.yaml:5" });
    expect(await verify(">=0.86.0")).toMatchObject({ status: "passed" });
  });
});

describe("naming a measurement copy in a run's output", () => {
  it("does not mistake a module whose directory ends in another's name for it", () => {
    const output = "/w/modules/media-type/.telo-floor-measure.yaml:5:1  error  nope  SCHEMA_VIOLATION";
    expect(mentions(output, "/w/modules/type/.telo-floor-measure.yaml")).toBe(false);
    expect(mentions(output, "/w/modules/media-type/.telo-floor-measure.yaml")).toBe(true);
  });
});

describe("attributing a rejection to the import closure", () => {
  const cachedDiagnostic =
    "../x/.telo/manifests/oci/ghcr.io/telorun/http-server/0.43.0/telo.yaml:137:7  error  Telo.Definition/Server: nope  SCHEMA_VIOLATION";

  it("counts a diagnostic located at a cached dependency as a rejection, rendered as the dependency", async () => {
    const file = writeModule("app");
    const probe = new FloorProbe(async () => ({ status: "failed", output: cachedDiagnostic }));
    const verdict = (await probe.probe("0.90.0", null, [{ key: "modules/app", manifestPath: file, text: fs.readFileSync(file, "utf8") }])).get("modules/app");
    expect(verdict).toEqual({
      accepted: false,
      reading: { version: "0.90.0", code: "SCHEMA_VIOLATION", location: "http-server@0.43.0 telo.yaml:137" },
    });
  });

  it("counts a diagnostic located at a relatively imported module as a rejection", async () => {
    writeModule("dep");
    const file = writeModule("app", { imports: "dep" });
    const dep = path.join(root, "modules", "dep", "telo.yaml");
    const probe = new FloorProbe(async () => ({
      status: "failed",
      output: `${dep}:9:1  error  nope  SCHEMA_VIOLATION`,
    }));
    const verdict = (await probe.probe("0.90.0", null, [{ key: "modules/app", manifestPath: file, text: fs.readFileSync(file, "utf8") }])).get("modules/app");
    expect(verdict).toEqual({
      accepted: false,
      reading: { version: "0.90.0", code: "SCHEMA_VIOLATION", location: path.join("..", "dep", "telo.yaml") + ":9" },
    });
  });

  it("still aborts on output naming no file of the closure", async () => {
    const file = writeModule("app");
    const probe = new FloorProbe(async () => ({
      status: "failed",
      output: "/elsewhere/other.yaml:3:1  error  nope  SCHEMA_VIOLATION",
    }));
    await expect(
      probe.probe("0.90.0", null, [{ key: "modules/app", manifestPath: file, text: fs.readFileSync(file, "utf8") }]),
    ).rejects.toThrow(FloorMeasurementError);
  });
});

describe("floors follow the siblings a module imports", () => {
  it("writes a dependent's floor as the highest of its measurement and its siblings', transitively", async () => {
    writeModule("base", { needs: "unreleased" });
    writeModule("middle", { imports: "base" });
    writeModule("top", { imports: "middle" });
    writeModule("versioned", { needs: "0.85.0" });
    writeModule("user", { needs: "0.82.0", imports: "versioned" });
    const workspace = loadWorkspace(root);

    const results = await measureAndWriteFloors(workspace, workspace.modules, {
      runner: fakeCli(),
      finals: FINALS,
    });

    const line = (key: string) => floorLine(results.find((r) => r.module.key === key)!);
    expect(line("modules/middle")).toBe("modules/middle: (none) → >=unreleased (imports modules/base at >=unreleased)");
    expect(line("modules/top")).toBe("modules/top: (none) → >=unreleased (imports modules/middle at >=unreleased)");
    expect(line("modules/user")).toBe("modules/user: (none) → >=0.85.0 (imports modules/versioned at >=0.85.0)");
    expect(floorIn(manifest("top"))).toBe("unreleased");
  });

  it("raises through a sibling that is not being measured, from its declared floor", async () => {
    writeModule("base", { floor: ">=0.88.0" });
    writeModule("user", { imports: "base" });
    const workspace = loadWorkspace(root);
    const results = await measureAndWriteFloors(
      workspace,
      workspace.modules.filter((m) => m.key === "modules/user"),
      { runner: fakeCli(), finals: FINALS },
    );
    expect(results[0]!.to).toEqual({ kind: "version", version: "0.88.0" });
  });

  const check = () =>
    checkWorkspaceRequires(loadWorkspace(root), { currentVersion: "0.90.0", runner: fakeCli(), finals: FINALS });

  it("holds a floor equal to a sibling's correct though the release below accepts the module", async () => {
    writeModule("base", { needs: "0.85.0", floor: ">=0.85.0" });
    writeModule("user", { floor: ">=0.85.0", imports: "base" });
    writeModule("waiting", { needs: "unreleased", floor: ">=unreleased" });
    writeModule("after", { floor: ">=unreleased", imports: "waiting" });
    expect((await check()).failures).toEqual([]);
  });

  it("fails a floor below a sibling's, naming the sibling and the raised measured value", async () => {
    writeModule("base", { needs: "0.85.0", floor: ">=0.85.0" });
    writeModule("low", { floor: ">=0.80.0", imports: "base" });
    writeModule("missing", { imports: "base" });
    const failures = (await check()).failures;
    expect(failures.map((f) => [f.module, f.code, f.measured]).sort()).toEqual([
      ["modules/low", "REQUIRES_FLOOR_TOO_LOW", ">=0.85.0"],
      ["modules/missing", "REQUIRES_FLOOR_TOO_LOW", ">=0.85.0"],
    ]);
    expect(failures.find((f) => f.module === "modules/low")!.message).toBe(
      "requires.telo is '>=0.80.0'; imports modules/base at >=0.85.0, and the lowest published telo that " +
        "accepts this module is 0.85.0 (imports modules/base at >=0.85.0). Run `telo release floor --module modules/low`.",
    );
  });
});

describe("what is not attributable fails", () => {
  it("keeps the cause when the measured floor of a failing module cannot be determined", async () => {
    writeModule("low", { needs: "0.85.0", floor: ">=0.80.0" });
    const inner = fakeCli();
    // The check runs pass through; the full measurement (V0 over the unfloored copy) breaks.
    const runner: CliRunner = async (version, paths) =>
      version === "0.77.0" ? { status: "failed", output: "the registry hiccuped" } : inner(version, paths);
    const [failure] = (
      await checkWorkspaceRequires(loadWorkspace(root), { currentVersion: "0.90.0", runner, finals: FINALS })
    ).failures;
    expect(failure!.message).toContain("the measured floor could not be determined (telo 0.77.0 exited without reporting on modules/low");
    expect(failure!.message).toContain("the registry hiccuped");
  });

  it("reports a floor it could not prove as an error, not a warning", async () => {
    writeModule("exact", { needs: "0.82.0", floor: ">=0.82.0" });
    const runner: CliRunner = async () => ({ status: "failed", output: "boom" });
    const result = await checkWorkspaceRequires(loadWorkspace(root), { currentVersion: "0.90.0", runner, finals: FINALS });
    expect(result.checks[0]).toMatchObject({ status: "unavailable" });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^telo >=0\.82\.0: telo 0\.82\.0 exited without reporting on modules\/exact/);
  });

  it("treats an import that could not be obtained as unmeasured, at the copy and in the closure", async () => {
    const file = writeModule("app");
    const modules = [{ key: "modules/app", manifestPath: file, text: fs.readFileSync(file, "utf8") }];
    const atCopy = new FloorProbe(async (_v, paths) => ({
      status: "failed",
      output: `${paths[0]}:3:1  error  could not fetch  IMPORT_UNRESOLVED`,
    }));
    await expect(atCopy.probe("0.90.0", null, modules)).rejects.toThrow(/could not obtain an import \(IMPORT_UNRESOLVED\)/);

    const cached =
      "../x/.telo/manifests/oci/ghcr.io/telorun/http-server/0.43.0/telo.yaml:1:1  error  could not fetch  IMPORT_UNRESOLVED";
    const inClosure = new FloorProbe(async () => ({ status: "failed", output: cached }));
    await expect(inClosure.probe("0.90.0", null, modules)).rejects.toThrow(FloorMeasurementError);

    const authors = new FloorProbe(async (_v, paths) => ({
      status: "failed",
      output: `${paths[0]}:3:1  error  not a source  INVALID_IMPORT_SOURCE`,
    }));
    expect((await authors.probe("0.90.0", null, modules)).get("modules/app")).toMatchObject({ accepted: false });
  });
});
