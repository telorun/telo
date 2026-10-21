import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultTransportRegistry } from "@telorun/kernel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { unpackPayload } from "../src/package/app-payload.js";
import { encodeTrailer, payloadDigest } from "../src/package/app-trailer.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";

/**
 * A packaged executable's payload is a sealed cache: reading the binary serves
 * every module the payload holds as it is — a mutable tag included — with no
 * request, removes nothing and writes nothing, and a start afterwards still
 * boots from it alone.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "cli/nodejs/bin/telo.ts");
const FIXTURE = path.join(ROOT, "cli/nodejs/tests/__fixtures__/sealed-payload");
const LIBRARY_REF = "oci://registry.test/acme/greetings@1.0.0";
const LIBRARY_CACHE_PATH = ["manifests", "oci", "registry.test", "acme", "greetings", "1.0.0", "telo.yaml"];
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);
const execFileAsync = promisify(execFile);

let dir: string;
let executable: string;
let unpackedTree: string;
let sealedCacheDigest: string;
let registry: net.Server;
/** Connections made to the registry address — every transport request goes
 *  through it, and each one is refused. */
let requests = 0;
let childEnv: NodeJS.ProcessEnv;

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = childEnv,
): Promise<{ stdout: string; stderr: string; status: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("bun", [CLI, ...args].map(quote), {
      cwd: dir,
      encoding: "utf8",
      shell: VIA_CMD,
      env,
    });
    return { stdout, stderr, status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), status: err.code ?? 1 };
  }
}

/** Every file and link beneath `root`, by relative path, with its contents. */
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isSymbolicLink()) hash.update(`${child}\0link:${fs.readlinkSync(path.join(root, child))}\n`);
      else hash.update(`${child}\0${createHash("sha256").update(fs.readFileSync(path.join(root, child))).digest("hex")}\n`);
    }
  };
  walk("");
  return hash.digest("hex");
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-sealed-payload-"));

  // Packaged while a stub registry serves the library under its tag, so the
  // payload's cache is the only place it exists once packaging is done.
  const library = fs.readFileSync(path.join(FIXTURE, "greetings.yaml"), "utf8");
  const oci = defaultTransportRegistry().forRef(LIBRARY_REF)!;
  const read = vi.spyOn(oci.source, "read").mockImplementation(async (url) => {
    if (url !== LIBRARY_REF) throw new Error(`unexpected registry read ${url}`);
    return { text: library, source: LIBRARY_REF };
  });
  const { payload, index } = await buildAppPayload({
    manifestPath: path.join(FIXTURE, "orders"),
    platform: { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" },
    report: () => {},
  });
  read.mockRestore();

  executable = path.join(dir, "orders");
  fs.writeFileSync(executable, Buffer.concat([Buffer.alloc(64, 1), payload, encodeTrailer(payload)]));
  unpackedTree = path.join(dir, "apps-root", "apps", `${index.app.name}-${payloadDigest(payload).slice(0, 16)}`);

  const pristine = path.join(dir, "pristine");
  await unpackPayload(payload, pristine);
  expect(fs.existsSync(path.join(pristine, "cache", ...LIBRARY_CACHE_PATH))).toBe(true);
  sealedCacheDigest = treeDigest(path.join(pristine, "cache"));

  // An unreachable registry that counts what reaches it: every transport goes
  // through this proxy, and every request fails.
  registry = net.createServer((socket) => {
    requests++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const proxy = `http://127.0.0.1:${(registry.address() as net.AddressInfo).port}`;
  childEnv = {
    ...process.env,
    TELO_APP_DIR: path.join(dir, "apps-root"),
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
  };
  for (const key of ["NO_PROXY", "no_proxy", "TELO_CACHE_DIR", "TELO_APP_CLI", "GREETING"]) delete childEnv[key];
}, 60_000);

afterAll(() => {
  registry?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a packaged executable's sealed cache", () => {
  it("is read as it is by every command that reads the binary: no request, nothing removed or written, and the start boots offline", async () => {
    // The counter sees the request a read of this tag makes where no cache
    // holds it.
    const empty = path.join(dir, "empty-cache");
    fs.mkdirSync(empty);
    const unsealed = await runCli(["describe", path.join(FIXTURE, "orders")], { ...childEnv, TELO_CACHE_DIR: empty });
    expect(unsealed.status).not.toBe(0);
    expect(requests).toBeGreaterThan(0);
    requests = 0;

    for (const command of [["check"], ["describe"], ["needs", "report"], ["env", "template"], ["cel", "functions"]]) {
      const result = await runCli([...command, executable]);
      expect(result.status, `${command.join(" ")}: ${result.stderr}`).toBe(0);
    }
    expect(requests).toBe(0);
    expect(treeDigest(path.join(unpackedTree, "cache"))).toBe(sealedCacheDigest);

    const start = await runCli(["run", executable]);
    expect(start.status, start.stderr).toBe(0);
    expect(requests).toBe(0);
  }, 120_000);

  it("judges the binary against its own payload's copy, beside a path whose cache holds another build of the tag", async () => {
    // `other` pins its own copy of the same tag, so nothing in this check
    // reaches the registry.
    const other = path.join(dir, "other");
    const otherLibrary = fs.readFileSync(path.join(FIXTURE, "other-greetings.yaml"));
    const pin = `sha256-${createHash("sha256").update(otherLibrary).digest("base64url")}`;
    fs.mkdirSync(path.join(other, ".telo", ...LIBRARY_CACHE_PATH.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(other, ".telo", ...LIBRARY_CACHE_PATH), otherLibrary);
    fs.writeFileSync(
      path.join(other, "telo.yaml"),
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: Other",
        "  version: 1.0.0",
        "imports:",
        `  Greetings: ${LIBRARY_REF}#${pin}`,
        "---",
        "kind: Greetings.Greeting",
        "metadata:",
        "  name: Salute",
        "salutation: hi",
        "",
      ].join("\n"),
    );

    requests = 0;
    const result = await runCli(["check", "-o", "json", other, executable]);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, errorCount: 0 });
    expect(requests).toBe(0);
  }, 60_000);
});
