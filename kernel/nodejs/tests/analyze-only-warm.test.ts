import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { LocalManifestCacheSource } from "../src/manifest-sources/local-manifest-cache-source.js";

/**
 * `kernel.load(entry, { analyzeOnly: true })` is the build-time warm pass
 * (`telo install`) bakes into a prebuilt image: it persists the analysis
 * stamp and the compiled `__validators` cache on a writable filesystem so the
 * runtime `load()` — on a read-only session rootfs — hits both caches and
 * never attempts a write. These tests pin that contract: warm once, freeze the
 * cache read-only, then a fresh runtime load must boot without a single
 * `[telo:kernel] … write failed` line on stderr.
 */

let workdir: string;
const REGISTRY = "https://registry.telo.run";

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-warm-"));
});

afterEach(async () => {
  // The test chmods the cache tree read-only; restore write perms top-down
  // (a read-only parent blocks rmdir of its children) before removing.
  for (const p of [
    workdir,
    path.join(workdir, ".telo"),
    path.join(workdir, ".telo/manifests"),
    path.join(workdir, ".telo/manifests/__validators"),
  ]) {
    await fs.chmod(p, 0o755).catch(() => {});
  }
  await fs.rm(workdir, { recursive: true, force: true });
});

function makeKernel(stderr?: { write: (s: string) => boolean }): Kernel {
  return new Kernel({
    sources: [new LocalFileSource(), new LocalManifestCacheSource(workdir, REGISTRY)],
    registryUrl: REGISTRY,
    ...(stderr ? { stderr: stderr as NodeJS.WritableStream } : {}),
  });
}

async function freezeReadOnly(): Promise<void> {
  const manifests = path.join(workdir, ".telo/manifests");
  for (const p of [path.join(manifests, "__validators"), manifests, path.join(workdir, ".telo"), workdir]) {
    try {
      await fs.chmod(p, 0o555);
    } catch {
      // not present — fine
    }
  }
}

describe("kernel.load analyzeOnly warm pass", () => {
  it("bakes the analysis stamp; runtime boot on a read-only fs writes nothing", async () => {
    const entry = path.join(workdir, "app.telo.yaml");
    await fs.writeFile(
      entry,
      `kind: Telo.Application\nmetadata:\n  name: WarmTest\n  version: 1.0.0\n`,
    );

    await makeKernel().load(entry, { analyzeOnly: true });

    const stamp = path.join(workdir, ".telo/manifests/.validated.json");
    await expect(fs.access(stamp)).resolves.toBeUndefined();

    await freezeReadOnly();

    let stderr = "";
    await makeKernel({ write: (s) => ((stderr += s), true) }).load(entry);
    expect(stderr).toBe("");
  });

  it("bakes application-env validators so resolveApplicationEnv hits the cache read-only", async () => {
    const entry = path.join(workdir, "app.telo.yaml");
    // variables + ports → resolveApplicationEnv compiles residual validators on
    // every boot, regardless of the stamp. The warm must pre-compile them.
    await fs.writeFile(
      entry,
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: WarmEnvTest",
        "  version: 1.0.0",
        "variables:",
        "  retries:",
        "    env: RETRIES",
        "    type: integer",
        "    default: 3",
        "ports:",
        "  http:",
        "    env: HTTP_PORT",
        "    default: 8080",
        "",
      ].join("\n"),
    );

    await makeKernel().load(entry, { analyzeOnly: true });

    const validators = path.join(workdir, ".telo/manifests/__validators");
    const baked = await fs.readdir(validators);
    expect(baked.length).toBeGreaterThan(0);

    await freezeReadOnly();

    let stderr = "";
    await makeKernel({ write: (s) => ((stderr += s), true) }).load(entry);
    expect(stderr).toBe("");
  });
});
