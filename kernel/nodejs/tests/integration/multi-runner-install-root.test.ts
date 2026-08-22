import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);

/**
 * Several telo installations over ONE workspace cache.
 *
 * The npm install root records the running CLI's own copy of `@telorun/sdk` as
 * a `file:` dependency, and npm rewrites that into a path relative to the root
 * — in `package.json`, in `package-lock.json`, and as the target of the link it
 * materializes. Once the cache is anchored at the workspace, every runner over
 * one checkout meets that tree, so a host process and a container bind-mounting
 * the same directory used to break each other's installs with `EMISSINGTARGET`,
 * taking down every resource behind an npm-delivered controller.
 *
 * This is an integration test rather than a unit one because the failure is
 * made of things a unit test has to fake: a second filesystem view of one
 * directory, a second CLI installation, and a second libc. Faking any of them
 * would leave the test asserting the fake.
 *
 * The three runners are the three real ones: the workspace's own CLI on the
 * host, and the same CLI inside a glibc and a musl image. The two containers
 * share a mount path (`/workspace`) on purpose — they differ ONLY by libc, so
 * they are what shows that axis of the key doing work. The cases that must NOT
 * separate matter just as much: several manifests in one workspace, and a
 * workspace copied to another directory at the same depth.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "__fixtures__", "multi-runner");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const HOST_CLI = path.join(REPO_ROOT, "cli", "nodejs", "bin", "telo.mjs");

const BUILDER_IMAGE = "telo-integration-build";
const SLIM_IMAGE = "telo-integration-slim";
const ALPINE_IMAGE = "telo-integration-alpine";

/** Long, because a cold run pulls module artifacts and runs a real `npm install`. */
const RUN_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 1_800_000;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, timeout: RUN_TIMEOUT_MS });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    // A non-zero exit is data here, not an error: several cases assert that a
    // runner SUCCEEDS where it used to fail, and the output is the evidence.
    return { stdout: err?.stdout ?? "", stderr: err?.stderr ?? "", code: err?.code ?? 1 };
  }
}

async function dockerAvailable(): Promise<boolean> {
  const probe = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  return probe.code === 0;
}

describe.skipIf(process.env.TELO_DOCKER_TESTS !== "1")("install root across runners", () => {
  let work: string;

  beforeAll(async () => {
    if (!(await dockerAvailable())) {
      throw new Error(
        "TELO_DOCKER_TESTS=1 was set but no Docker daemon answered. Start Docker or unset it.",
      );
    }
    // The shipped build stage, then one runtime image per libc from it.
    const builder = await run(
      "docker",
      ["build", "--target", "build", "-t", BUILDER_IMAGE, "-f", "cli/nodejs/Dockerfile", "."],
      REPO_ROOT,
    );
    expect(builder.code, `builder image failed:\n${builder.stderr}`).toBe(0);
    for (const [target, tag] of [
      ["slim", SLIM_IMAGE],
      ["alpine", ALPINE_IMAGE],
    ] as const) {
      const built = await run(
        "docker",
        ["build", "--target", target, "--build-arg", `BUILDER=${BUILDER_IMAGE}`, "-t", tag, "."],
        FIXTURE,
      );
      expect(built.code, `${target} image failed:\n${built.stderr}`).toBe(0);
    }
  }, BUILD_TIMEOUT_MS);

  beforeEach(async () => {
    // A fresh workspace per case: these assert on which roots EXIST, so state
    // left by a previous case would make every count meaningless.
    work = await fs.mkdtemp(path.join(os.tmpdir(), "telo-multi-runner-"));
    for (const file of ["telo.yaml", "telo-workspace.yaml"]) {
      await fs.copyFile(path.join(FIXTURE, file), path.join(work, file));
    }
  });

  afterAll(async () => {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  });

  /** The workspace CLI, as a host process — the developer's own `telo run`. */
  function onHost(manifest = "telo.yaml"): Promise<RunResult> {
    return run(process.execPath, [HOST_CLI, manifest], work);
  }

  /**
   * The same CLI in a container. `--user` matches the host uid so the shared
   * cache stays writable from both sides afterwards; without it the container
   * writes root-owned files into the workspace and every later host run fails
   * on permissions rather than on anything this test is about.
   */
  function inContainer(image: string, mountAt = "/workspace"): Promise<RunResult> {
    return run("docker", [
      "run",
      "--rm",
      "--user",
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "-v",
      `${work}:${mountAt}`,
      "-w",
      mountAt,
      image,
      `${mountAt}/telo.yaml`,
    ]);
  }

  /** Install roots present in the shared cache. */
  async function roots(): Promise<string[]> {
    return (await fs.readdir(path.join(work, ".telo", "npm")).catch(() => [] as string[])).sort();
  }

  async function markers(): Promise<Array<{ realm: string[]; os?: string; libc?: string }>> {
    const out = [];
    for (const root of await roots()) {
      const file = path.join(work, ".telo", "npm", root, ".telo-install-root.json");
      out.push(JSON.parse(await fs.readFile(file, "utf8")));
    }
    return out;
  }

  const ranClean = (result: RunResult) => {
    expect(result.code, `run failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("probe-ok");
  };

  it("gives each runner its own root, and none breaks the next", async () => {
    ranClean(await onHost());
    expect(await roots()).toHaveLength(1);

    ranClean(await inContainer(SLIM_IMAGE));
    ranClean(await inContainer(ALPINE_IMAGE));

    // Three runners, three roots: the host by its own path, and the two
    // containers — identical mount path, identical bytes — separated by libc.
    expect(await roots()).toHaveLength(3);
    const seen = await markers();
    expect(new Set(seen.map((m) => m.libc))).toEqual(new Set(["gnu", "musl"]));
    // The two containers share a mount path and a CLI, so their realm paths
    // match and only libc tells them apart; the host's differs outright.
    expect(new Set(seen.map((m) => m.realm.join()))).toHaveLength(2);

    // The host run that used to fail with EMISSINGTARGET once a container had
    // written the lockfile.
    ranClean(await onHost());
    expect(await roots()).toHaveLength(3);
  }, RUN_TIMEOUT_MS * 4);

  it("survives all three runners starting at once on a cold cache", async () => {
    const [host, slim, alpine] = await Promise.all([
      onHost(),
      inContainer(SLIM_IMAGE),
      inContainer(ALPINE_IMAGE),
    ]);
    // Concurrency is the case the directory lock exists for, and a cold cache is
    // when all three race to materialize a root rather than read one.
    for (const result of [host, slim, alpine]) ranClean(result);
    expect(await roots()).toHaveLength(3);
  }, RUN_TIMEOUT_MS * 2);

  it("reuses each root on a repeat run rather than growing the cache", async () => {
    ranClean(await onHost());
    ranClean(await inContainer(SLIM_IMAGE));
    const after = await roots();

    ranClean(await onHost());
    ranClean(await inContainer(SLIM_IMAGE));
    expect(await roots()).toEqual(after);
  }, RUN_TIMEOUT_MS * 4);

  it("reuses a warmed root when the same runner sees the workspace at another path", async () => {
    // Same depth, so npm's relative paths still resolve — the tree is shared by
    // the key itself, with nothing to adopt or validate.
    // `telo install` in one directory, `telo run` from another — the shipped
    // Dockerfile's `WORKDIR /build` … `COPY --from=build /build /srv` shape. The
    // manifest's bytes are the same, the CLI is the same, only the path moved.
    ranClean(await inContainer(SLIM_IMAGE, "/build"));
    const warmed = await roots();
    expect(warmed).toHaveLength(1);

    ranClean(await inContainer(SLIM_IMAGE, "/srv"));
    expect(await roots()).toEqual(warmed);
  }, RUN_TIMEOUT_MS * 2);

  it("survives the same runner seeing the workspace at a different DEPTH", async () => {
    // The reported failure, reduced: the recorded realm dependency does not
    // change (one CLI, one image), but npm records it RELATIVE to the install
    // root, so a workspace mounted one level down and then five resolves that
    // path somewhere else — `EMISSINGTARGET` on the install, or a dangling link
    // that fails later at the controller's import. Depth is the variable here,
    // which is why this case exists beside the `/build` → `/srv` one.
    ranClean(await inContainer(SLIM_IMAGE, "/w"));
    ranClean(await inContainer(SLIM_IMAGE, "/deep/a/b/c/w"));
  }, RUN_TIMEOUT_MS * 2);

  it("separates two libcs, even at one path", async () => {
    ranClean(await inContainer(SLIM_IMAGE, "/build"));
    // Same path, same CLI, different libc: a native build is not interchangeable.
    ranClean(await inContainer(ALPINE_IMAGE, "/build"));
    expect(await roots()).toHaveLength(2);
  }, RUN_TIMEOUT_MS * 2);

  it("keeps one root as the manifest is edited", async () => {
    ranClean(await onHost());
    const manifest = path.join(work, "telo.yaml");
    const original = await fs.readFile(manifest, "utf8");

    for (let edit = 0; edit < 3; edit++) {
      await fs.writeFile(manifest, `${original}\n# edit ${edit}\n`);
      ranClean(await onHost());
    }

    // The key names the runner, not the app, so editing under `--watch` neither
    // moves the tree nor leaves anything behind.
    expect(await roots()).toHaveLength(1);
  }, RUN_TIMEOUT_MS * 4);

  it("keeps one root for several manifests in one workspace", async () => {
    // One repo, one cache: keying on the entry manifest gave each app its own
    // tree and each its own `npm install`, which is what the workspace-anchored
    // cache exists to avoid.
    await fs.copyFile(path.join(work, "telo.yaml"), path.join(work, "second.yaml"));
    ranClean(await onHost());
    ranClean(await onHost("second.yaml"));

    expect(await roots()).toHaveLength(1);
  }, RUN_TIMEOUT_MS * 2);
});
